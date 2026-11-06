import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createAppServer } from '../server/app.js';

let server;
let port;

before(async () => {
  server = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

/** A WebSocket client (Node's built-in one) with "wait for the next message like …". */
async function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  };
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const c = {
    ws,
    closed,
    inbox,
    send: (o) => ws.send(JSON.stringify(o)),
    next(pred, ms = 2000) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) waiters.splice(k, 1), reject(new Error('timed out waiting for a message'));
        }, ms).unref();
      });
    },
    async cmd(text) {
      const n = ++id;
      c.send({ type: 'cmd', id: n, text });
      return c.next((m) => m.id === n);
    },
  };
  return c;
}

const text = (res) => res.lines.map((l) => l.text).join('\n');

async function createSession(name = 'Alice') {
  const a = await client();
  a.send({ type: 'create', name });
  const welcome = await a.next((m) => m.type === 'welcome');
  return { a, welcome, code: welcome.session };
}

test('create, join, push: others see origin change and an activity note', async () => {
  const { a, welcome, code } = await createSession();
  assert.match(code, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal(welcome.created, true);
  assert.equal(welcome.you.name, 'Alice');

  const b = await client();
  b.send({ type: 'join', session: code.toUpperCase(), name: 'Bob' });
  const wb = await b.next((m) => m.type === 'welcome');
  assert.equal(wb.created, false);
  assert.deepEqual(wb.state.remote.branches, welcome.state.remote.branches);
  const joined = await a.next((m) => m.type === 'activity');
  assert.deepEqual(joined, { type: 'activity', who: 'Bob', items: ['joined the session'] });
  const people = await a.next((m) => m.type === 'people' && m.people.length === 2);
  assert.deepEqual(people.people.map((p) => [p.name, p.online]), [['Alice', true], ['Bob', true]]);

  assert.ok((await a.cmd('git commit -m "from alice"')).ok);
  const push = await a.cmd('git push');
  assert.ok(push.ok, text(push));
  const aliceTip = push.state.remote.branches.find(([n]) => n === 'main')[1];

  const update = await b.next((m) => m.type === 'state');
  assert.equal(new Map(update.state.remote.branches).get('main'), aliceTip, "Bob's REMOTE panel shows the push");
  assert.notEqual(new Map(update.state.local.remoteRefs).get('origin/main'), aliceTip, 'but his origin/main waits for a fetch');
  const news = await b.next((m) => m.type === 'activity');
  assert.equal(news.who, 'Alice');
  assert.match(news.items[0], /pushed 1 commit to origin\/main/);

  assert.ok((await b.cmd('git commit -m "from bob"')).ok);
  const rejected = await b.cmd('git push');
  assert.equal(rejected.ok, false);
  assert.match(text(rejected), /fetch first/);
  assert.ok((await b.cmd('git pull --rebase')).ok);
  assert.ok((await b.cmd('git push')).ok);
  assert.match((await a.next((m) => m.type === 'activity')).items[0], /pushed 1 commit/);

  a.ws.close();
  b.ws.close();
});

test('join errors: unknown session, bad name, name in use', async () => {
  const { a, code } = await createSession('Dana');
  const c = await client();
  c.send({ type: 'join', session: 'aaaa-bbbb-cccc', name: 'X' });
  assert.equal((await c.next((m) => m.type === 'error')).code, 'not_found');
  c.send({ type: 'join', session: code, name: '   ' });
  assert.equal((await c.next((m) => m.type === 'error')).code, 'invalid_name');
  c.send({ type: 'join', session: code, name: 'dana' });
  assert.equal((await c.next((m) => m.type === 'error')).code, 'name_taken', 'names are compared case-insensitively');
  c.send({ type: 'cmd', id: 1, text: 'git status' });
  assert.equal((await c.next((m) => m.type === 'error')).code, 'bad_request', 'commands need a session first');
  a.ws.close();
  c.ws.close();
});

test('rejoining keeps your repository: by token, or by name once you are offline', async () => {
  const { a, welcome, code } = await createSession('Erin');
  await a.cmd('git switch -c wip');
  await a.cmd('git commit -m local-only');

  // Second tab / reconnect with the token, while the first is still open.
  const again = await client();
  again.send({ type: 'join', session: code, token: welcome.token });
  const w2 = await again.next((m) => m.type === 'welcome');
  assert.equal(w2.resumed, true);
  assert.equal(w2.you.id, welcome.you.id);
  assert.equal(w2.state.local.head.name, 'wip');

  // Both tabs gone: coming back by name picks up the same repository.
  a.ws.close();
  again.ws.close();
  await Promise.all([a.closed, again.closed]);
  await new Promise((r) => setTimeout(r, 50));
  const later = await client();
  later.send({ type: 'join', session: code, name: 'ERIN' });
  const w3 = await later.next((m) => m.type === 'welcome');
  assert.equal(w3.you.id, welcome.you.id);
  assert.equal(w3.state.local.head.name, 'wip');
  later.ws.close();
});

test('bad input does not take the server down', async () => {
  const { a } = await createSession('Finn');
  a.ws.send('not json');
  assert.equal((await a.next((m) => m.type === 'error')).code, 'bad_request');
  a.ws.send('[1,2]');
  assert.equal((await a.next((m) => m.type === 'error')).code, 'bad_request');
  a.ws.send('{"__proto__":{"type":"cmd"},"id":5}');
  assert.equal((await a.next((m) => m.type === 'error')).code, 'bad_request');
  for (const cmd of ['git __proto__', 'git constructor', 'git hasOwnProperty']) {
    const r = await a.cmd(cmd);
    assert.equal(r.ok, false);
    assert.match(text(r), /not a git command/);
  }
  const big = await a.cmd('x'.repeat(5000));
  assert.equal(big.code, 'bad_request');
  assert.ok((await a.cmd('git status')).ok, 'still works');
  a.ws.close();
});

test('messages over the size limit close the connection with 1009', async () => {
  const { a } = await createSession('Gus');
  a.ws.send('x'.repeat(20 * 1024));
  assert.equal(await a.closed, 1009);
});

// ---- raw frames: what Node's and browsers' clients never send on their own ----

function rawSocket(headers = {}) {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    sock.on('error', reject);
    sock.on('data', function onHead(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      sock.off('data', onHead);
      resolve({ sock, status: buf.subarray(0, end).toString().split(' ')[1], rest: buf.subarray(end + 4) });
    });
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    sock.write(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`,
    );
  });
}

/** One masked client frame. */
function frame(opcode, payload, { fin = true } = {}) {
  const data = Buffer.from(payload);
  const mask = randomBytes(4);
  const len = data.length;
  const head = len < 126 ? Buffer.from([0, 0x80 | len]) : Buffer.from([0, 0x80 | 126, len >> 8, len & 0xff]);
  head[0] = (fin ? 0x80 : 0) | opcode;
  const body = Buffer.from(data.map((b, i) => b ^ mask[i & 3]));
  return Buffer.concat([head, mask, body]);
}

/** Read unmasked server frames from a socket, as parsed JSON. */
function reader(sock, initial) {
  let buf = initial;
  const msgs = [];
  let wake = null;
  const parse = () => {
    while (buf.length >= 2) {
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      }
      if (buf.length < off + len) return;
      if ((buf[0] & 0x0f) === 0x1) msgs.push(JSON.parse(buf.subarray(off, off + len).toString()));
      buf = buf.subarray(off + len);
    }
  };
  parse();
  sock.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    parse();
    wake?.();
  });
  return async function next() {
    while (!msgs.length) await new Promise((r) => (wake = r));
    return msgs.shift();
  };
}

test('frames split across packets, batched together, or fragmented all parse', async () => {
  const { sock, status, rest } = await rawSocket({ Origin: `http://127.0.0.1:${port}` });
  assert.equal(status, '101');
  const next = reader(sock, rest);

  // One message, delivered a few bytes at a time.
  const create = frame(0x1, JSON.stringify({ type: 'create', name: 'Raw' }));
  for (let i = 0; i < create.length; i += 5) {
    sock.write(create.subarray(i, i + 5));
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal((await next()).type, 'welcome');
  assert.equal((await next()).type, 'people');

  // Two messages in one packet, the second one fragmented with a ping in between.
  const second = JSON.stringify({ type: 'cmd', id: 2, text: 'git commit -m "in pieces"' });
  sock.write(
    Buffer.concat([
      frame(0x1, JSON.stringify({ type: 'cmd', id: 1, text: 'git status' })),
      frame(0x1, second.slice(0, 10), { fin: false }),
      frame(0x9, 'hi'),
      frame(0x0, second.slice(10, 20), { fin: false }),
      frame(0x0, second.slice(20)),
    ]),
  );
  const r1 = await next();
  assert.equal(r1.id, 1);
  assert.ok(r1.ok);
  const r2 = await next();
  assert.equal(r2.id, 2);
  assert.match(r2.lines[0].text, /in pieces/);
  sock.destroy();
});

test('handshakes from another origin or for another path are refused', async () => {
  assert.equal((await rawSocket({ Origin: 'https://evil.example' })).status, '403');
  const r = await new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1');
    sock.on('data', (c) => resolve(c.toString().split(' ')[1]));
    sock.write(`GET /other HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  assert.equal(r, '404');
});

test('unmasked and binary frames close the connection', async () => {
  for (const [bytes, code] of [
    [Buffer.from([0x81, 0x02, 0x68, 0x69]), 1002], // unmasked "hi"
    [frame(0x2, 'hi'), 1003], // binary
  ]) {
    const { sock, rest } = await rawSocket();
    const closeCode = new Promise((resolve) => {
      let buf = rest;
      const check = () => {
        if (buf.length >= 4 && (buf[0] & 0x0f) === 0x8) resolve(buf.readUInt16BE(2));
      };
      check();
      sock.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        check();
      });
    });
    sock.write(bytes);
    assert.equal(await closeCode, code);
    sock.destroy();
  }
});
