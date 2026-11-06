// A small WebSocket server (RFC 6455) on top of node:http's 'upgrade' event, so the
// project stays dependency-free. It supports what browsers use: text messages
// (fragmented or not), ping/pong and the closing handshake. No extensions
// (permessage-deflate) and no subprotocols; binary messages are refused.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const MAX_BUFFERED_OUT = 4 * 1024 * 1024; // a client that stops reading gets dropped

/** Write a bare HTTP error on a socket that asked to upgrade, then hang up. */
export function rejectUpgrade(socket, status, reason, extraHeaders = '') {
  if (socket.writable) {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n${extraHeaders}\r\n`);
  }
  socket.destroy();
}

/**
 * Complete the opening handshake for an 'upgrade' request.
 * Returns a WebSocket, or null after answering with an HTTP error.
 */
export function acceptUpgrade(req, socket, head, { maxPayload = 64 * 1024 } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    rejectUpgrade(socket, 400, 'Bad Request');
    return null;
  }
  if (req.headers['sec-websocket-version'] !== '13') {
    rejectUpgrade(socket, 426, 'Upgrade Required', 'Sec-WebSocket-Version: 13\r\n');
    return null;
  }
  // The key is 16 random bytes, base64-encoded.
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    rejectUpgrade(socket, 400, 'Bad Request');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new WebSocket(socket, head, { maxPayload });
}

/**
 * Events: 'message' (text: string), 'close' (code: number). `alive` is cleared by
 * the heartbeat and set again when a pong arrives.
 */
export class WebSocket extends EventEmitter {
  #socket;
  #buf = Buffer.alloc(0);
  #fragments = null; // Buffers of a fragmented text message in progress
  #fragmentBytes = 0;
  #maxPayload;
  #closeSent = false;
  #closed = false;
  #decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(socket, head, { maxPayload }) {
    super();
    this.#socket = socket;
    this.#maxPayload = maxPayload;
    this.alive = true;
    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.#finish(1006));
    if (head?.length) queueMicrotask(() => this.#onData(head));
  }

  get open() { return !this.#closeSent && !this.#closed; }

  send(text) {
    if (!this.open) return;
    if (this.#socket.writableLength > MAX_BUFFERED_OUT) {
      this.terminate();
      return;
    }
    this.#write(OP.TEXT, Buffer.from(text, 'utf8'));
  }

  ping() {
    if (this.open) this.#write(OP.PING, Buffer.alloc(0));
  }

  /** Start the closing handshake; the peer answers with its own close frame. */
  close(code = 1000, reason = '') {
    if (this.#closeSent || this.#closed) return;
    const r = Buffer.from(reason, 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this.#write(OP.CLOSE, payload);
    this.#closeSent = true;
    // Don't wait forever for a peer that never answers.
    setTimeout(() => this.#socket.destroy(), 3000).unref();
  }

  /** Drop the connection without a handshake. */
  terminate() {
    this.#socket.destroy();
  }

  #write(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 0x10000) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.#socket.write(Buffer.concat([header, payload]));
  }

  #onData(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    // One chunk can hold several frames, or only part of one.
    while (!this.#closed && this.#buf.length >= 2) {
      const b = this.#buf;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (rsv) return this.#fail(1002, 'unexpected RSV bits');
      if (!masked) return this.#fail(1002, 'client frames must be masked');
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.#maxPayload)) return this.#fail(1009, 'message too big');
        len = Number(big);
        off = 10;
      }
      if (len > this.#maxPayload) return this.#fail(1009, 'message too big');
      if (b.length < off + 4 + len) return; // wait for the rest of the frame
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len)); // copy: unmasked in place
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.#buf = b.subarray(off + 4 + len);
      this.#onFrame(fin, opcode, payload);
    }
  }

  #onFrame(fin, opcode, payload) {
    if (opcode >= 0x8) {
      // Control frames: never fragmented, at most 125 bytes, may arrive between fragments.
      if (!fin || payload.length > 125) return this.#fail(1002, 'bad control frame');
      if (opcode === OP.CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (!this.#closeSent) this.close(code === 1005 ? 1000 : code);
        this.#socket.end();
        this.#finish(code);
      } else if (opcode === OP.PING) {
        if (this.open) this.#write(OP.PONG, payload);
      } else if (opcode === OP.PONG) {
        this.alive = true;
      } else {
        this.#fail(1002, 'unknown opcode');
      }
      return;
    }
    if (opcode === OP.BINARY) return this.#fail(1003, 'only text messages are supported');
    if (opcode === OP.TEXT) {
      if (this.#fragments) return this.#fail(1002, 'expected a continuation frame');
      if (fin) return this.#deliver(payload);
      this.#fragments = [payload];
      this.#fragmentBytes = payload.length;
      return;
    }
    if (opcode === OP.CONT) {
      if (!this.#fragments) return this.#fail(1002, 'unexpected continuation frame');
      this.#fragmentBytes += payload.length;
      if (this.#fragmentBytes > this.#maxPayload) return this.#fail(1009, 'message too big');
      this.#fragments.push(payload);
      if (fin) {
        const whole = Buffer.concat(this.#fragments);
        this.#fragments = null;
        this.#deliver(whole);
      }
      return;
    }
    this.#fail(1002, 'unknown opcode');
  }

  #deliver(buf) {
    let text;
    try {
      text = this.#decoder.decode(buf);
    } catch {
      return this.#fail(1007, 'invalid UTF-8');
    }
    if (this.#closeSent) return; // closing: ignore late messages
    this.emit('message', text);
  }

  #fail(code, reason) {
    this.close(code, reason);
    this.#socket.end();
    this.#finish(code);
  }

  #finish(code) {
    if (this.#closed) return;
    this.#closed = true;
    this.#buf = Buffer.alloc(0);
    this.#fragments = null;
    this.emit('close', code);
  }
}
