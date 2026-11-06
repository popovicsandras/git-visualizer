// Entry point: turns a command line into state changes + output lines.

import { GitError, tokenize } from './parse.js';
import { World } from './world.js';
import * as local from './local.js';
import * as remote from './remote.js';
import { cd, pwd, worktree } from './worktree.js';

export { World };
export { DEFAULT_BRANCH, MAIN_WORKTREE, REMOTE, isValidBranchName, mulberry32, relativePath, resolvePath } from './world.js';

const GIT = {
  commit: local.commit,
  branch: local.branch,
  checkout: (w, a) => local.checkout(w, a, 'checkout'),
  switch: (w, a) => local.checkout(w, a, 'switch'),
  merge: local.merge,
  rebase: local.rebase,
  reset: local.reset,
  'cherry-pick': local.cherryPick,
  revert: local.revert,
  log: local.log,
  status: local.status,
  worktree,
  fetch: remote.fetch,
  pull: remote.pull,
  push: remote.push,
  remote: remote.remoteCmd,
  help: (w) => helpLines(w.shared),
};

export const GIT_COMMANDS = Object.keys(GIT);

/** `shared`: in a session with real teammates (no teammate simulation; undo is personal). */
export function helpLines(shared = false) {
  const rows = [
    ['Basics', ''],
    ['git commit [-m "msg"] [--amend]', 'record a new commit on the current branch'],
    ['git branch [<name> [<start>]]', 'list / create branches (-d, -D, -m, -a, -vv)'],
    ['git checkout <branch|commit>', 'move HEAD (-b <new> to create and switch)'],
    ['git switch <branch>', 'move HEAD to a branch (-c <new>, --detach)'],
    ['git merge <ref>', 'fast-forward or create a merge commit (--no-ff, --ff-only)'],
    ['git rebase <upstream>', 'replay your commits on top of another branch'],
    ['git reset [--hard] <ref>', 'move the current branch to another commit'],
    ['git cherry-pick <ref>', 'copy a commit onto HEAD'],
    ['git revert <ref>', 'add a commit that undoes another'],
    ['git log [--oneline] [--all]', 'list commits'],
    ['git status', 'where am I, ahead/behind origin?'],
    ['git worktree add -b <new> <path> [<base>]', 'check out a new branch in another folder'],
    ['git worktree list', 'show every worktree and what it has checked out'],
    ['git worktree remove <path>', 'delete a worktree folder (its branch is kept)'],
    ['Remote', ''],
    ['git fetch [--prune]', 'download origin\'s commits, update origin/* refs'],
    ['git pull [--rebase]', 'fetch + merge (or rebase) the upstream branch'],
    ['git push [-u] [origin <branch>]', 'upload commits (-f to force, --delete)'],
    ...(shared
      ? [
          ['Shell (not git)', ''],
          ['cd <worktree folder>', 'move the prompt into another worktree (cd - goes back)'],
          ['pwd', 'which worktree folder the prompt is in'],
          ['undo', 'rewind YOUR repository by one command (origin is shared: it stays)'],
          ['clear', 'clear this console'],
        ]
      : [
          ['Simulation (not git)', ''],
          ['remote commit [<branch>] [-m msg]', 'a teammate pushes a commit to origin'],
          ['remote branch <name> [<from>]', 'a teammate pushes a new branch'],
          ['cd <worktree folder>', 'move the prompt into another worktree (cd - goes back)'],
          ['pwd', 'which worktree folder the prompt is in'],
          ['undo', 'revert the last state-changing command'],
          ['clear', 'clear this console  (page refresh resets everything)'],
        ]),
  ];
  const lines = [];
  for (const [a, b] of rows) {
    if (!b) lines.push({ kind: 'heading', text: a });
    else lines.push({ kind: 'out', text: `  ${a.padEnd(42)} ${b}` });
  }
  lines.push({ kind: 'note', text: 'Revisions: branch names, origin/main, HEAD, HEAD~2, main^, or a hash prefix.' });
  lines.push({
    kind: 'note',
    text: 'Note: plain "git pull" here merges when branches have diverged (like pull.rebase=false). Real git ≥ 2.33 asks you to choose --rebase or --no-rebase first.',
  });
  return lines;
}

const toLine = (l) => (typeof l === 'string' ? { kind: 'err', text: l } : l);

/**
 * Run one command line against the world.
 * Returns { lines: [{kind, text}], ok: boolean, clear?: boolean }.
 */
export function run(w, input) {
  const text = input.trim();
  if (!text) return { lines: [], ok: true };
  let tokens;
  try {
    tokens = tokenize(text);
  } catch (e) {
    return { lines: e.lines.map(toLine), ok: false };
  }
  const [cmd, ...rest] = tokens;

  if (cmd === 'clear') return { lines: [], ok: true, clear: true };
  if (cmd === 'help' || cmd === '?') return { lines: helpLines(w.shared), ok: true };
  if (cmd === 'undo') return { lines: w.undo(), ok: true };

  let handler;
  let args;
  if (cmd === 'cd' || cmd === 'pwd') {
    handler = cmd === 'cd' ? cd : pwd;
    args = rest;
  } else if (cmd === 'remote' || cmd === 'teammate') {
    handler = remote.teammate;
    args = rest;
  } else if (cmd === 'git') {
    const sub = rest[0];
    if (!sub) return { lines: helpLines(w.shared), ok: true };
    // hasOwn: typed text must never reach inherited keys like "constructor" or "__proto__".
    handler = Object.hasOwn(GIT, sub) ? GIT[sub] : undefined;
    args = rest.slice(1);
    if (!handler) {
      return {
        lines: [
          { kind: 'err', text: `git: '${sub}' is not a git command (in this visualizer). See 'help'.` },
        ],
        ok: false,
      };
    }
  } else {
    const suggestion = Object.hasOwn(GIT, cmd) ? ` Did you mean "git ${text}"?` : ' Type "help" to see what you can do.';
    return { lines: [{ kind: 'err', text: `${cmd}: command not found.${suggestion}` }], ok: false };
  }

  const before = w.signature();
  const snap = w.snapshot();
  let lines;
  let ok = true;
  try {
    lines = handler(w, args) ?? [];
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    lines = e.lines.map(toLine);
    ok = false;
  }
  if (w.signature() !== before) w.remember(snap);
  return { lines: lines.map(toLine), ok };
}
