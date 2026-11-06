// Connects WebSocket clients to sessions.
//
// Protocol (JSON text messages):
//   client → server
//     { type: 'create', name }                       start a session
//     { type: 'join', session, name?, token? }       join one (token: rejoin as yourself)
//     { type: 'cmd', id, text }                      run a command line
//     { type: 'reclone', id }                        replace your repository with a fresh clone
//   server → client
//     { type: 'welcome', session, you, token, created, resumed, state, people }
//     { type: 'error', code, message, id? }          code: bad_request | not_found | name_taken | invalid_name | full | rate_limited | internal
//     { type: 'result', id, lines, ok, clear?, state }   answer to cmd / reclone
//     { type: 'state', state }                       your view changed because of someone else
//     { type: 'people', people }                     who is in the session, and online
//     { type: 'activity', who, items }               someone pushed / joined
//
// Sessions live in memory until the server stops; there is no way to delete one.

import { randomInt } from 'node:crypto';
import { Session } from './session.js';

export const LIMITS = {
  sessions: 1000,
  membersPerSession: 50,
  nameLength: 24,
  commandLength: 1000,
  // Token bucket per connection: a burst of `burst` messages, refilled at `perSecond`.
  burst: 40,
  perSecond: 20,
};

// No 0/o/1/l/i, so a code read out loud or copied by hand survives.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const SESSION_CODE = /^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/;

function newCode() {
  const part = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return `${part()}-${part()}-${part()}`;
}

/** Trimmed, single-spaced name, or null if it can't be used. */
export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  const length = [...name].length;
  if (!length || length > LIMITS.nameLength) return null;
  // Control characters, zero-width and bidi-override characters could fake other text.
  if (/[\p{Cc}​-‏‪-‮⁠-⁩﻿]/u.test(name)) return null;
  return name;
}

export class Hub {
  sessions = new Map(); // code -> Session
  #online = new Map(); // member id -> Set of connections
  #conns = new Set();

  /** Take over a freshly upgraded WebSocket. */
  connect(ws) {
    const conn = { ws, session: null, member: null, tokens: LIMITS.burst, refilled: Date.now() };
    this.#conns.add(conn);
    ws.on('message', (text) => {
      if (!this.#allow(conn)) {
        this.#send(conn, { type: 'error', code: 'rate_limited', message: 'Slow down: too many messages.' });
        return;
      }
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return this.#send(conn, { type: 'error', code: 'bad_request', message: 'Messages must be JSON.' });
      }
      try {
        this.#handle(conn, msg);
      } catch (e) {
        console.error('hub: error while handling a message:', e);
        this.#send(conn, { type: 'error', code: 'internal', message: 'Internal server error.', id: msg?.id });
      }
    });
    ws.on('close', () => this.#disconnect(conn));
  }

  /** Called on an interval: drop connections that stopped answering pings. */
  heartbeat() {
    for (const { ws } of this.#conns) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }

  #allow(conn) {
    const now = Date.now();
    conn.tokens = Math.min(LIMITS.burst, conn.tokens + ((now - conn.refilled) / 1000) * LIMITS.perSecond);
    conn.refilled = now;
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  }

  #handle(conn, msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
      return this.#error(conn, 'bad_request', 'Expected an object with a "type".');
    }
    if (!conn.member) {
      switch (msg.type) {
        case 'create': return this.#create(conn, msg);
        case 'join': return this.#join(conn, msg);
        default: return this.#error(conn, 'bad_request', 'Create or join a session first.');
      }
    }
    switch (msg.type) {
      case 'cmd': return this.#command(conn, msg);
      case 'reclone': return this.#reclone(conn, msg);
      default: return this.#error(conn, 'bad_request', `Unknown message type.`, msg.id);
    }
  }

  #create(conn, msg) {
    const name = cleanName(msg.name);
    if (!name) return this.#nameError(conn);
    if (this.sessions.size >= LIMITS.sessions) {
      return this.#error(conn, 'full', 'This server has reached its session limit. Join an existing session instead.');
    }
    let code;
    do code = newCode();
    while (this.sessions.has(code));
    const session = new Session(code);
    this.sessions.set(code, session);
    const member = session.addMember(name);
    console.log(`session ${code} created by ${JSON.stringify(name)} (${this.sessions.size} in memory)`);
    this.#enter(conn, session, member, { created: true, resumed: false });
  }

  #join(conn, msg) {
    const code = typeof msg.session === 'string' ? msg.session.trim().toLowerCase() : '';
    const session = SESSION_CODE.test(code) ? this.sessions.get(code) : undefined;
    if (!session) {
      return this.#error(conn, 'not_found', 'There is no session with that code. It may have ended when the server restarted.');
    }
    // Rejoining as yourself (page reload, dropped connection): the token proves it.
    const byToken = session.memberByToken(msg.token);
    if (byToken) return this.#enter(conn, session, byToken, { created: false, resumed: true });
    if (msg.name === undefined && msg.token !== undefined) {
      return this.#error(conn, 'not_found', 'That rejoin link has expired. Join again with your name.');
    }

    const name = cleanName(msg.name);
    if (!name) return this.#nameError(conn);
    const existing = session.memberByName(name);
    if (existing) {
      // There are no accounts: someone who comes back from another browser picks up
      // their old repository by name, as long as that person isn't connected now.
      if (this.#online.get(existing.id)?.size) {
        return this.#error(conn, 'name_taken', `${existing.name} is already in this session. Pick another name.`);
      }
      return this.#enter(conn, session, existing, { created: false, resumed: true });
    }
    if (session.members.size >= LIMITS.membersPerSession) {
      return this.#error(conn, 'full', 'This session is full.');
    }
    const member = session.addMember(name);
    this.#enter(conn, session, member, { created: false, resumed: false });
    this.#broadcast(session, { type: 'activity', who: member.name, items: ['joined the session'] }, member);
  }

  #enter(conn, session, member, { created, resumed }) {
    conn.session = session;
    conn.member = member;
    if (!this.#online.has(member.id)) this.#online.set(member.id, new Set());
    this.#online.get(member.id).add(conn);
    this.#send(conn, {
      type: 'welcome',
      session: session.id,
      you: { id: member.id, name: member.name },
      token: member.token,
      created,
      resumed,
      state: session.view(member),
      people: this.#people(session),
    });
    this.#broadcastPeople(session);
  }

  #command(conn, msg) {
    if (typeof msg.text !== 'string' || msg.text.length > LIMITS.commandLength) {
      return this.#error(conn, 'bad_request', `Commands can be at most ${LIMITS.commandLength} characters.`, msg.id);
    }
    const { session, member } = conn;
    this.#respond(conn, msg.id, session.run(member, msg.text));
  }

  #reclone(conn, msg) {
    this.#respond(conn, msg.id, conn.session.reclone(conn.member));
  }

  /** Answer the sender, then update everyone else the change is visible to. */
  #respond(conn, id, res) {
    const { session, member } = conn;
    const state = session.view(member);
    this.#send(conn, { type: 'result', id, lines: res.lines, ok: res.ok, clear: res.clear, state });
    // The same person in another tab.
    for (const other of this.#online.get(member.id) ?? []) {
      if (other !== conn) this.#send(other, { type: 'state', state });
    }
    // Origin changed: everyone's REMOTE panel changes (their origin/* refs don't, until they fetch).
    if (res.activity.length) {
      for (const m of session.members.values()) {
        if (m === member) continue;
        const conns = this.#online.get(m.id);
        if (!conns?.size) continue;
        const update = JSON.stringify({ type: 'state', state: session.view(m) });
        const news = JSON.stringify({ type: 'activity', who: member.name, items: res.activity });
        for (const c of conns) {
          c.ws.send(update);
          c.ws.send(news);
        }
      }
    }
  }

  #disconnect(conn) {
    this.#conns.delete(conn);
    const { session, member } = conn;
    if (!member) return;
    const conns = this.#online.get(member.id);
    conns?.delete(conn);
    if (conns && !conns.size) {
      this.#online.delete(member.id);
      this.#broadcastPeople(session);
    }
  }

  #people(session) {
    return [...session.members.values()].map((m) => ({ id: m.id, name: m.name, online: Boolean(this.#online.get(m.id)?.size) }));
  }

  #broadcastPeople(session) {
    this.#broadcast(session, { type: 'people', people: this.#people(session) });
  }

  /** Send to every connected member of `session`, except `skip`. */
  #broadcast(session, msg, skip = null) {
    const text = JSON.stringify(msg);
    for (const m of session.members.values()) {
      if (m === skip) continue;
      for (const c of this.#online.get(m.id) ?? []) c.ws.send(text);
    }
  }

  #nameError(conn) {
    this.#error(conn, 'invalid_name', `Enter a name of 1 to ${LIMITS.nameLength} characters.`);
  }

  #error(conn, code, message, id) {
    this.#send(conn, { type: 'error', code, message, ...(id !== undefined && { id }) });
  }

  #send(conn, msg) {
    conn.ws.send(JSON.stringify(msg));
  }
}
