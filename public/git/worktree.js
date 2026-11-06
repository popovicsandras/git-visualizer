// `git worktree`: extra working folders that share this repository's commits and
// branches, each with its own HEAD. `cd` moves the prompt between them.

import { GitError, parseOpts } from './parse.js';
import { MAIN_WORKTREE, isValidBranchName, relativePath, resolvePath } from './world.js';
import { assertNotInOtherWorktree, note, out } from './local.js';

const basename = (path) => path.slice(path.lastIndexOf('/') + 1);

export function worktree(w, args) {
  const [sub, ...rest] = args;
  if (sub === 'add') return add(w, rest);
  if (sub === 'list') return list(w, rest);
  if (sub === 'remove' || sub === 'rm') return remove(w, rest);
  if (!sub) throw new GitError(usage());
  throw new GitError([`error: unknown subcommand: \`${sub}'`, ...usage()]);
}

function usage() {
  return [
    'usage: git worktree add [-b <new-branch>] <path> [<commit-ish>]',
    '   or: git worktree list',
    '   or: git worktree remove [-f] <worktree>',
  ];
}

/** Find a worktree by its path (as typed from the current folder) or by its folder name. */
export function findWorktree(w, arg) {
  const path = resolvePath(arg, w.cwd);
  if (w.local.worktrees.has(path)) return path;
  const byName = [...w.local.worktrees.keys()].filter((p) => basename(p) === arg);
  return byName.length === 1 ? byName[0] : null;
}

function add(w, args) {
  const { opts, pos } = parseOpts(args, {
    '-b': { key: 'create', value: true },
    '-B': { key: 'forceCreate', value: true },
    '--detach': { key: 'detach' },
    '-d': { key: 'detach' },
    '-f': { key: 'force' },
    '--force': { key: 'force' },
    '-q': { key: 'quiet' },
  });
  const l = w.local;
  const [target, commitish] = pos;
  if (!target) throw new GitError(usage());
  const path = resolvePath(target, w.cwd);
  if (l.worktrees.has(path)) throw new GitError(`fatal: '${target}' already exists`);

  let newBranch = opts.create ?? opts.forceCreate;
  let head;
  let prep;
  if (!newBranch && !opts.detach && commitish && l.branches.has(commitish)) {
    // Check out an existing branch.
    if (w.currentBranch() === commitish) {
      throw new GitError(`fatal: '${commitish}' is already used by worktree at '${w.cwd}'`);
    }
    assertNotInOtherWorktree(w, commitish);
    head = { type: 'branch', name: commitish };
    prep = `Preparing worktree (checking out '${commitish}')`;
  } else if (opts.detach || (commitish && !newBranch)) {
    const id = w.mustResolve(commitish ?? 'HEAD');
    head = { type: 'detached', id };
    prep = `Preparing worktree (detached HEAD ${w.short(id)})`;
  } else {
    // -b <name>, or DWIM: a new branch named after the folder.
    newBranch ??= basename(path);
    if (!isValidBranchName(newBranch)) throw new GitError(`fatal: '${newBranch}' is not a valid branch name`);
    const existed = l.branches.has(newBranch);
    if (existed && !opts.forceCreate) throw new GitError(`fatal: a branch named '${newBranch}' already exists`);
    if (existed && (w.currentBranch() === newBranch || w.worktreeUsing(newBranch))) {
      throw new GitError(`fatal: '${newBranch}' is already used by worktree at '${w.worktreeUsing(newBranch) ?? w.cwd}'`);
    }
    const id = w.mustResolve(commitish ?? 'HEAD');
    l.branches.set(newBranch, id);
    head = { type: 'branch', name: newBranch };
    prep = existed ? `Preparing worktree (resetting branch '${newBranch}')` : `Preparing worktree (new branch '${newBranch}')`;
  }

  l.worktrees.set(path, { path, head });
  const id = w.worktreeHeadId({ head });
  const where = head.type === 'branch' ? `branch '${head.name}'` : 'a detached HEAD';
  return [
    out(prep),
    out(`HEAD is now at ${w.oneline(id)}`),
    note(
      `New folder ${path} has ${where} checked out at ${w.short(id)}. It shares this repo's commits and branches, ` +
        `but has its own HEAD, so you can work on two branches at once. Run "cd ${relativePath(path, w.cwd)}" to work in it.`,
    ),
  ];
}

function list(w, args) {
  parseOpts(args, { '-v': { key: 'verbose' }, '--verbose': { key: 'verbose' }, '--porcelain': { key: 'porcelain' } });
  const all = w.worktreeList();
  const width = Math.max(...all.map((t) => t.path.length)) + 2;
  return all.map((t) => {
    const id = w.worktreeHeadId(t);
    const ref = t.head.type === 'branch' ? `[${t.head.name}]` : '(detached HEAD)';
    return out(`${t.path.padEnd(width)}${w.short(id)} ${ref}`);
  });
}

function remove(w, args) {
  const { pos } = parseOpts(args, { '-f': { key: 'force' }, '--force': { key: 'force' } });
  if (!pos.length) throw new GitError(usage());
  const path = findWorktree(w, pos[0]);
  if (!path) throw new GitError(`fatal: '${pos[0]}' is not a working tree`);
  if (path === MAIN_WORKTREE) throw new GitError(`fatal: '${pos[0]}' is a main working tree`);
  if (path === w.cwd) {
    throw new GitError([
      `fatal: '${pos[0]}' is the current working tree`,
      { kind: 'hint', text: `hint: cd to another worktree first, e.g. "cd ${relativePath(MAIN_WORKTREE, w.cwd)}"` },
    ]);
  }
  const t = w.local.worktrees.get(path);
  w.local.worktrees.delete(path);
  const kept =
    t.head.type === 'branch'
      ? `Branch '${t.head.name}' and its commits are kept; delete it with "git branch -d ${t.head.name}" if you no longer need it.`
      : `Its detached HEAD was at ${w.short(t.head.id)}; commits only reachable from there are now unreachable.`;
  return [note(`Removed worktree ${path}. ${kept}`)];
}

// ---- shell: cd / pwd (not git) ------------------------------------------------

export function cd(w, args) {
  const l = w.local;
  if (args.length > 1) throw new GitError('cd: too many arguments');
  const [arg] = args;
  if (arg === undefined || arg === '~') {
    throw new GitError([
      'cd: only worktree folders exist in this simulation',
      { kind: 'note', text: `Worktrees: ${[...l.worktrees.keys()].join(', ')}` },
    ]);
  }
  let path;
  if (arg === '-') {
    if (!l.oldpwd || !l.worktrees.has(l.oldpwd)) throw new GitError('cd: OLDPWD not set');
    path = l.oldpwd;
  } else {
    path = resolvePath(arg, w.cwd);
  }
  if (!l.worktrees.has(path)) {
    throw new GitError([
      `cd: no such file or directory: ${arg}`,
      { kind: 'note', text: `Only worktree folders exist here: ${[...l.worktrees.keys()].map((p) => relativePath(p, w.cwd)).join(', ')}` },
    ]);
  }
  if (path === w.cwd) return [];
  w.switchWorktree(path);
  const h = l.head;
  const at = h.type === 'branch' ? `HEAD → ${h.name}` : `a detached HEAD at ${w.short(h.id)}`;
  return [note(`Now in ${path}, where ${at}. Git commands act on this worktree's HEAD.`)];
}

export function pwd(w) {
  return [out(w.cwd)];
}
