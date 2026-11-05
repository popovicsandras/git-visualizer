// In-memory model of a local repository and its "origin" remote.
// Nothing here touches real git; it's a simulation for teaching.

import { GitError } from './parse.js';

export const REMOTE = 'origin';
export const DEFAULT_BRANCH = 'main';
export const REMOTE_URL = 'https://git.example.com/team/project.git';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function isValidBranchName(name) {
  return (
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('//') &&
    name !== 'HEAD'
  );
}

export class World {
  constructor({ seed } = {}) {
    this.rand = mulberry32(seed ?? Math.floor(Math.random() * 2 ** 32));
    this.history = [];
    this.state = {
      seq: 0,
      counter: 0,
      objects: new Map(), // id -> { id, parents, message, author, seq, copiedFrom? }
      local: {
        has: new Set(), // commit ids present in the local object store
        branches: new Map(), // name -> id
        remoteRefs: new Map(), // 'origin/name' -> id  (remote-tracking branches)
        upstream: new Map(), // local branch name -> 'origin/name'
        head: { type: 'branch', name: DEFAULT_BRANCH }, // or { type: 'detached', id }
      },
      remote: {
        has: new Set(),
        branches: new Map(),
      },
    };
    // Start as if the repo was just cloned: three commits in a row on main, present on both sides.
    let tip = null;
    for (let i = 0; i < 3; i++) {
      const c = this.createCommit(tip ? [tip] : [], tip ? this.nextMessage() : 'Initial commit', 'you');
      this.local.has.add(c.id);
      this.remote.has.add(c.id);
      tip = c.id;
    }
    this.local.branches.set(DEFAULT_BRANCH, tip);
    this.remote.branches.set(DEFAULT_BRANCH, tip);
    this.local.remoteRefs.set(`${REMOTE}/${DEFAULT_BRANCH}`, tip);
    this.local.upstream.set(DEFAULT_BRANCH, `${REMOTE}/${DEFAULT_BRANCH}`);
  }

  get local() { return this.state.local; }
  get remote() { return this.state.remote; }
  get objects() { return this.state.objects; }

  // ---- undo support -------------------------------------------------------
  snapshot() { return structuredClone(this.state); }
  signature() {
    const { local: l, remote: r } = this.state;
    return JSON.stringify([
      this.state.seq, l.head, [...l.branches], [...l.remoteRefs], [...l.upstream],
      l.has.size, [...r.branches], r.has.size,
    ]);
  }

  // ---- commits -------------------------------------------------------------
  newId() {
    let id;
    do {
      id = Math.floor(this.rand() * 0x10000000).toString(16).padStart(7, '0');
    } while (this.objects.has(id));
    return id;
  }

  createCommit(parents, message, author = 'you', extra = {}) {
    const c = { id: this.newId(), parents: [...parents], message, author, seq: ++this.state.seq, ...extra };
    this.objects.set(c.id, c);
    return c;
  }

  nextMessage() { return `C${++this.state.counter}`; }
  commit(id) { return this.objects.get(id); }

  // ---- HEAD ----------------------------------------------------------------
  headId() {
    const h = this.local.head;
    return h.type === 'branch' ? this.local.branches.get(h.name) : h.id;
  }
  currentBranch() {
    return this.local.head.type === 'branch' ? this.local.head.name : null;
  }
  /** Move whatever HEAD points to (the current branch, or HEAD itself when detached). */
  moveHead(id) {
    const h = this.local.head;
    if (h.type === 'branch') this.local.branches.set(h.name, id);
    else h.id = id;
  }

  // ---- graph queries -------------------------------------------------------
  ancestors(id) {
    const seen = new Set();
    const stack = id ? [id] : [];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...this.commit(cur).parents);
    }
    return seen;
  }
  isAncestor(a, b) { return this.ancestors(b).has(a); }

  /** Commits reachable from `to` but not from `from`, oldest first. */
  range(from, to) {
    const exclude = this.ancestors(from);
    return [...this.ancestors(to)]
      .filter((id) => !exclude.has(id))
      .sort((x, y) => this.commit(x).seq - this.commit(y).seq);
  }

  /** Every commit reachable from some ref in the given repo ('local' | 'remote'). */
  reachable(which) {
    const repo = this.state[which];
    const tips = [...repo.branches.values()];
    if (which === 'local') {
      tips.push(...repo.remoteRefs.values());
      tips.push(this.headId());
    }
    const all = new Set();
    for (const t of tips) for (const id of this.ancestors(t)) all.add(id);
    return all;
  }

  // ---- ref resolution ------------------------------------------------------
  /** Resolve a revision like main, origin/main, HEAD~2, a1b2c3d, feature^2 in the given repo. */
  resolve(rev, which = 'local') {
    const m = /^(.*?)((?:[~^]\d*)*)$/.exec(rev);
    let id = this.resolveBase(m[1], which);
    if (!id) return null;
    for (const [, op, digits] of m[2].matchAll(/([~^])(\d*)/g)) {
      const n = digits === '' ? 1 : Number(digits);
      if (op === '~') {
        for (let i = 0; i < n && id; i++) id = this.commit(id).parents[0];
      } else if (n > 0) {
        id = this.commit(id).parents[n - 1];
      }
      if (!id) return null;
    }
    return id;
  }

  resolveBase(name, which) {
    const repo = this.state[which];
    if (which === 'local' && (name === 'HEAD' || name === '@')) return this.headId();
    if (repo.branches.has(name)) return repo.branches.get(name);
    if (which === 'local') {
      const short = name.replace(/^(refs\/)?remotes\//, '');
      if (repo.remoteRefs.has(short)) return repo.remoteRefs.get(short);
      if (name.startsWith('refs/heads/') && repo.branches.has(name.slice(11))) return repo.branches.get(name.slice(11));
    }
    if (/^[0-9a-f]{4,40}$/.test(name)) {
      const hits = [...repo.has].filter((id) => id.startsWith(name) || name.startsWith(id));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw new GitError(`error: short object ID ${name} is ambiguous`);
    }
    return null;
  }

  mustResolve(rev, which = 'local') {
    const id = this.resolve(rev, which);
    if (!id) {
      throw new GitError([
        `fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`,
      ]);
    }
    return id;
  }

  short(id) { return id.slice(0, 7); }
  oneline(id) { return `${this.short(id)} ${this.commit(id).message.split('\n')[0]}`; }
}
