// Browser side of a shared session: one WebSocket to the server, request/response
// for commands, pushed updates for everything else, and automatic reconnects.
// See server/hub.js for the protocol.

export class SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const socketUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

export class SessionClient {
  /**
   * handlers: onState(state), onPeople(people), onActivity({ who, items }),
   *           onStatus('online' | 'reconnecting'), onLost(error)  (gave up: back to the lobby)
   */
  constructor(handlers) {
    this.h = handlers;
    this.ws = null;
    this.session = null; // { code, token } once joined (kept while reconnecting)
    this.ready = false; // welcomed on the current socket
    this.pending = new Map(); // request id -> { resolve, reject }
    this.nextId = 1;
    this.retry = 0;
    this.retryTimer = null;
  }

  get connected() { return this.ready && this.ws?.readyState === WebSocket.OPEN; }

  create(name) { return this.#enter({ type: 'create', name }); }

  /** Join by name, or rejoin as yourself with the token from an earlier welcome. */
  join(code, { name, token } = {}) {
    return this.#enter({ type: 'join', session: code, ...(name !== undefined && { name }), ...(token && { token }) });
  }

  /** Run a command line. Resolves with { lines, ok, clear?, state }. */
  command(text) { return this.#request({ type: 'cmd', text }); }
  reclone() { return this.#request({ type: 'reclone' }); }

  leave() {
    this.session = null;
    this.ready = false;
    clearTimeout(this.retryTimer);
    this.#rejectAll('You left the session.');
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000);
  }

  // Open a socket, send create/join, resolve with the welcome (or reject with the error).
  #enter(hello) {
    clearTimeout(this.retryTimer);
    this.ws?.close(1000);
    this.ready = false;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(socketUrl());
      this.ws = ws;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        if (this.ws === ws) this.ws = null;
        ws.close();
        reject(err);
      };
      ws.onopen = () => ws.send(JSON.stringify(hello));
      ws.onerror = () => fail(new SessionError('offline', "Can't reach the server. Is it running?"));
      ws.onclose = () => {
        if (!settled) fail(new SessionError('offline', 'The connection closed before the session started.'));
        else this.#onDrop(ws);
      };
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (!settled) {
          if (msg.type === 'welcome') {
            settled = true;
            this.session = { code: msg.session, token: msg.token };
            this.ready = true;
            this.retry = 0;
            resolve(msg);
          } else if (msg.type === 'error') {
            fail(new SessionError(msg.code, msg.message));
          }
          return;
        }
        this.#onMessage(msg);
      };
    });
  }

  #request(body) {
    if (!this.connected) return Promise.reject(new SessionError('offline', 'Not connected to the session. Reconnecting…'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...body, id }));
    });
  }

  #onMessage(msg) {
    switch (msg.type) {
      case 'result': {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p?.resolve(msg);
        break;
      }
      case 'error': {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (p) p.reject(new SessionError(msg.code, msg.message));
        else console.warn('session error:', msg.message);
        break;
      }
      case 'state': this.h.onState?.(msg.state); break;
      case 'people': this.h.onPeople?.(msg.people); break;
      case 'activity': this.h.onActivity?.(msg); break;
    }
  }

  #rejectAll(message) {
    for (const p of this.pending.values()) p.reject(new SessionError('offline', message));
    this.pending.clear();
  }

  // The socket dropped after we were in: keep trying to rejoin with our token.
  #onDrop(ws) {
    if (this.ws !== ws) return; // replaced, or closed on purpose
    this.ws = null;
    this.ready = false;
    this.#rejectAll('Lost the connection to the server.');
    const target = this.session;
    if (!target) return;
    this.h.onStatus?.('reconnecting');
    const attempt = () => {
      if (this.session !== target) return; // left meanwhile
      this.join(target.code, { token: target.token })
        .then((welcome) => this.h.onStatus?.('online', welcome))
        .catch((err) => {
          if (this.session !== target) return;
          if (err.code === 'offline') {
            this.retry++;
            this.retryTimer = setTimeout(attempt, Math.min(10_000, 500 * 2 ** this.retry));
          } else {
            this.session = null;
            this.h.onLost?.(err);
          }
        });
    };
    this.retryTimer = setTimeout(attempt, 300);
  }
}
