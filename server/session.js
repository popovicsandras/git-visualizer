// A shared git session: one origin that everyone pushes to, and a separate local
// clone for every member. The git engine in public/git runs here unchanged; each
// command runs against a World whose `local` is the member's own repository and
// whose objects, origin and counters belong to the session.
//
// Nothing here knows about sockets; see hub.js for that.

import { randomBytes } from 'node:crypto';
import { World, run, mulberry32, REMOTE } from '../public/git/index.js';

const note = (text) => ({ kind: 'note', text });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One member's view of the session. Undo only rewinds the member's own
 * repository: origin is shared, so taking a push back would rewrite other
 * people's history under them.
 */
class MemberWorld extends World {
  snapshot() {
    return { local: structuredClone(this.state.local), origin: this.remoteSignature() };
  }
  remember(snap) {
    snap.changedOrigin = snap.origin !== this.remoteSignature();
    super.remember(snap);
  }
  undo() {
    const snap = this.history.pop();
    if (!snap) return [note('Nothing to undo.')];
    this.state.local = snap.local;
    const lines = [note('Undid your last command in your own repository.')];
    if (snap.changedOrigin) {
      lines.push(
        note(
          'That command also changed origin, which everyone in this session shares, so origin stays as it is. ' +
            'To take back something already pushed, add a "git revert" commit (or, carefully, "git push --force").',
        ),
      );
    }
    return lines;
  }
}

export class Session {
  constructor(id, { seed } = {}) {
    this.id = id;
    this.createdAt = Date.now();
    this.rand = mulberry32(seed);
    // Shared by everyone: every commit ever made in the session, origin, and the
    // counters behind commit order (graph columns) and default messages (C1, C2, …).
    this.shared = {
      seq: 0,
      counter: 0,
      objects: new Map(),
      remote: { has: new Set(), branches: new Map() },
    };
    this.members = new Map(); // id -> member
  }

  get origin() { return this.shared.remote; }

  /** Add someone. Their repository starts as a fresh clone of origin as it is now. */
  addMember(name) {
    const member = {
      id: randomBytes(6).toString('base64url'),
      token: randomBytes(18).toString('base64url'),
      name,
      local: null,
      history: [],
      joinedAt: Date.now(),
    };
    const w = this.#world(member);
    // The first member (the creator) authors origin's starting commits.
    if (!this.origin.branches.size) w.seedOrigin();
    w.state.local = w.cloneLocal();
    this.#save(w, member);
    this.members.set(member.id, member);
    return member;
  }

  memberByToken(token) {
    if (typeof token !== 'string') return null;
    for (const m of this.members.values()) if (m.token === token) return m;
    return null;
  }

  memberByName(name) {
    const key = name.toLocaleLowerCase();
    for (const m of this.members.values()) if (m.name.toLocaleLowerCase() === key) return m;
    return null;
  }

  /**
   * Run one command line as `member`.
   * Returns run()'s { lines, ok, clear? } plus `activity`: what changed on origin,
   * worded for the other members (empty when origin didn't change).
   */
  run(member, text) {
    const w = this.#world(member);
    const before = new Map(this.origin.branches);
    try {
      return { ...run(w, text), activity: this.#describeOriginChanges(w, before) };
    } finally {
      this.#save(w, member);
    }
  }

  /** Throw away the member's repository and clone origin again (undo brings it back). */
  reclone(member) {
    const w = this.#world(member);
    const snap = w.snapshot();
    w.state.local = w.cloneLocal();
    w.remember(snap);
    this.#save(w, member);
    return {
      ok: true,
      lines: [
        { kind: 'out', text: `Cloning into 'project'...` },
        note('Your repository is a fresh clone of origin again. Your old one is gone (use "undo" to bring it back).'),
      ],
      activity: [],
    };
  }

  /** JSON for what `member` sees: their own repository plus origin. */
  view(member) {
    return this.#world(member).toView();
  }

  #world(member) {
    const s = this.shared;
    return new MemberWorld({
      state: { seq: s.seq, counter: s.counter, objects: s.objects, local: member.local, remote: s.remote },
      rand: this.rand,
      author: member.name,
      shared: true,
      history: member.history,
    });
  }

  /** Copy back what a command may have replaced or counted up. */
  #save(w, member) {
    this.shared.seq = w.state.seq;
    this.shared.counter = w.state.counter;
    member.local = w.state.local;
  }

  #describeOriginChanges(w, before) {
    const after = this.origin.branches;
    const items = [];
    const names = [...new Set([...before.keys(), ...after.keys()])].sort();
    for (const b of names) {
      const old = before.get(b);
      const now = after.get(b);
      if (old === now) continue;
      if (!now) {
        items.push(`deleted branch ${b} from ${REMOTE}`);
      } else if (!old) {
        items.push(`pushed a new branch ${b} to ${REMOTE} (${w.short(now)})`);
      } else if (w.isAncestor(old, now)) {
        const n = w.range(old, now).length;
        items.push(`pushed ${plural(n, 'commit')} to ${REMOTE}/${b} (${w.short(old)}..${w.short(now)})`);
      } else {
        items.push(`force-pushed ${REMOTE}/${b} (${w.short(old)}...${w.short(now)}): commits only on the old tip are gone from ${b}`);
      }
    }
    return items;
  }
}
