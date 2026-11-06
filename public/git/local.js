// Commands that only touch the local repository.

import { GitError, parseOpts } from './parse.js';
import { REMOTE, isValidBranchName } from './world.js';

// Output line helpers. `note` lines are teaching explanations, not real git output.
export const out = (text) => ({ kind: 'out', text });
export const hint = (text) => ({ kind: 'hint', text: `hint: ${text}` });
export const warn = (text) => ({ kind: 'warn', text });
export const note = (text) => ({ kind: 'note', text });

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const patchOf = (c) => c.patch ?? c.id;

function headLabel(w) {
  return w.currentBranch() ?? 'detached HEAD';
}

function assertBranchName(name) {
  if (!isValidBranchName(name)) throw new GitError(`fatal: '${name}' is not a valid branch name`);
}

/** A branch can be checked out in only one worktree at a time. */
export function assertNotInOtherWorktree(w, name) {
  const path = w.worktreeUsing(name);
  if (path) throw new GitError(`fatal: '${name}' is already used by worktree at '${path}'`);
}

/** "Your branch is ahead of ..." lines for a local branch, or [] without an upstream. */
export function trackingInfo(w, branch) {
  const up = w.local.upstream.get(branch);
  if (!up) return [];
  const upId = w.local.remoteRefs.get(up);
  if (!upId) {
    return [out(`Your branch is based on '${up}', but the upstream is gone.`)];
  }
  const id = w.local.branches.get(branch);
  const ahead = w.range(upId, id).length;
  const behind = w.range(id, upId).length;
  if (!ahead && !behind) return [out(`Your branch is up to date with '${up}'.`)];
  if (ahead && !behind) {
    return [
      out(`Your branch is ahead of '${up}' by ${plural(ahead, 'commit')}.`),
      out(`  (use "git push" to publish your local commits)`),
    ];
  }
  if (!ahead) {
    return [
      out(`Your branch is behind '${up}' by ${plural(behind, 'commit')}, and can be fast-forwarded.`),
      out(`  (use "git pull" to update your local branch)`),
    ];
  }
  return [
    out(`Your branch and '${up}' have diverged,`),
    out(`and have ${ahead} and ${behind} different commits each, respectively.`),
    out(`  (use "git pull" if you want to integrate the remote branch with yours)`),
  ];
}

/** Ref names pointing at a commit, formatted like `git log --decorate`. */
export function decorations(w, id) {
  const l = w.local;
  const names = [];
  if (l.head.type === 'detached' && l.head.id === id) names.push('HEAD');
  for (const [name, tip] of [...l.branches].sort()) {
    if (tip !== id) continue;
    names.push(l.head.type === 'branch' && l.head.name === name ? `HEAD -> ${name}` : name);
  }
  for (const [name, tip] of [...l.remoteRefs].sort()) if (tip === id) names.push(name);
  names.sort((a, b) => (b.startsWith('HEAD') ? 1 : 0) - (a.startsWith('HEAD') ? 1 : 0));
  return names;
}

// ---- commit ----------------------------------------------------------------

export function commit(w, args) {
  const { opts, pos } = parseOpts(args, {
    '-m': { key: 'message', value: true, multi: true },
    '--message': { key: 'message', value: true, multi: true },
    '-a': { key: 'all' },
    '--all': { key: 'all' },
    '--amend': { key: 'amend' },
    '--allow-empty': { key: 'allowEmpty' },
    '--no-edit': { key: 'noEdit' },
    '-q': { key: 'quiet' },
  });
  if (pos.length) throw new GitError(`error: pathspec '${pos[0]}' did not match any file(s) known to git`);
  const head = w.headId();
  const msg = opts.message?.join('\n\n');
  let c;
  if (opts.amend) {
    const old = w.commit(head);
    c = w.createCommit(old.parents, msg ?? old.message, 'you');
  } else {
    c = w.createCommit([head], msg ?? w.nextMessage());
  }
  w.local.has.add(c.id);
  w.moveHead(c.id);
  const lines = [out(`[${headLabel(w)} ${w.short(c.id)}] ${c.message.split('\n')[0]}`)];
  if (opts.amend) {
    lines.push(note(`--amend made a brand-new commit ${w.short(c.id)} replacing ${w.short(head)}; the old one is left behind.`));
  }
  return lines;
}

// ---- branch ----------------------------------------------------------------

export function branch(w, args) {
  const { opts, pos } = parseOpts(args, {
    '-d': { key: 'delete' },
    '--delete': { key: 'delete' },
    '-D': { key: 'forceDelete' },
    '-a': { key: 'all' },
    '--all': { key: 'all' },
    '-r': { key: 'remotes' },
    '--remotes': { key: 'remotes' },
    '-v': { key: 'verbose' },
    '--verbose': { key: 'verbose' },
    '--list': { key: 'list' },
    '-l': { key: 'list' },
    '-m': { key: 'move' },
    '-M': { key: 'move' },
    '--move': { key: 'move' },
    '-f': { key: 'force' },
    '--force': { key: 'force' },
    '-u': { key: 'setUpstream', value: true },
    '--set-upstream-to': { key: 'setUpstream', value: true },
    '--unset-upstream': { key: 'unsetUpstream' },
    '--show-current': { key: 'showCurrent' },
  });
  const l = w.local;
  const cur = w.currentBranch();

  if (opts.showCurrent) return cur ? [out(cur)] : [];

  if (opts.delete || opts.forceDelete) {
    if (!pos.length) throw new GitError('fatal: branch name required');
    const lines = [];
    for (const name of pos) {
      if (!l.branches.has(name)) throw new GitError(`error: branch '${name}' not found.`);
      if (name === cur) throw new GitError(`error: cannot delete branch '${name}' used by your working tree (you are on it)`);
      const wt = w.worktreeUsing(name);
      if (wt) throw new GitError(`error: cannot delete branch '${name}' used by worktree at '${wt}'`);
      const id = l.branches.get(name);
      const up = l.upstream.get(name);
      const mergedInto = up && l.remoteRefs.get(up) ? l.remoteRefs.get(up) : w.headId();
      if (!opts.forceDelete && !w.isAncestor(id, mergedInto)) {
        throw new GitError([
          `error: the branch '${name}' is not fully merged.`,
          { kind: 'hint', text: `hint: If you are sure you want to delete it, run 'git branch -D ${name}'` },
        ]);
      }
      l.branches.delete(name);
      l.upstream.delete(name);
      lines.push(out(`Deleted branch ${name} (was ${w.short(id)}).`));
    }
    return lines;
  }

  if (opts.move) {
    const [from, to] = pos.length >= 2 ? pos : [cur, pos[0]];
    if (!from || !to) throw new GitError('fatal: branch name required');
    if (!l.branches.has(from)) throw new GitError(`error: refname refs/heads/${from} not found`);
    assertBranchName(to);
    if (l.branches.has(to)) throw new GitError(`fatal: a branch named '${to}' already exists`);
    l.branches.set(to, l.branches.get(from));
    l.branches.delete(from);
    if (l.upstream.has(from)) {
      l.upstream.set(to, l.upstream.get(from));
      l.upstream.delete(from);
    }
    if (from === cur) l.head = { type: 'branch', name: to };
    const wt = w.worktreeUsing(from);
    if (wt) l.worktrees.get(wt).head = { type: 'branch', name: to };
    return [note(`Renamed branch '${from}' to '${to}'.`)];
  }

  if (opts.setUpstream || opts.unsetUpstream) {
    const name = pos[0] ?? cur;
    if (!name || !l.branches.has(name)) throw new GitError(`fatal: branch '${name}' does not exist`);
    if (opts.unsetUpstream) {
      l.upstream.delete(name);
      return [note(`Branch '${name}' no longer tracks a remote branch.`)];
    }
    if (!l.remoteRefs.has(opts.setUpstream)) {
      throw new GitError(`fatal: the requested upstream branch '${opts.setUpstream}' does not exist`);
    }
    l.upstream.set(name, opts.setUpstream);
    return [out(`branch '${name}' set up to track '${opts.setUpstream}'.`)];
  }

  if (!pos.length || opts.list) {
    const lines = [];
    const fmt = (id) => (opts.verbose ? ` ${w.oneline(id)}` : '');
    if (!opts.remotes) {
      if (l.head.type === 'detached') lines.push(out(`* (HEAD detached at ${w.short(l.head.id)})${fmt(l.head.id)}`));
      for (const [name, id] of [...l.branches].sort()) {
        const up = opts.verbose && l.upstream.get(name) ? ` [${l.upstream.get(name)}]` : '';
        lines.push(out(`${name === cur ? '* ' : '  '}${name}${fmt(id)}${up}`));
      }
    }
    if (opts.all || opts.remotes) {
      for (const [name, id] of [...l.remoteRefs].sort()) {
        lines.push(out(`  ${opts.all ? 'remotes/' : ''}${name}${fmt(id)}`));
      }
    }
    return lines;
  }

  const [name, start = 'HEAD'] = pos;
  assertBranchName(name);
  if (l.branches.has(name) && !opts.force) throw new GitError(`fatal: a branch named '${name}' already exists`);
  if (l.branches.has(name) && name === cur) throw new GitError(`fatal: cannot force update the current branch.`);
  if (l.branches.has(name) && w.worktreeUsing(name)) {
    throw new GitError(`fatal: cannot force update the branch '${name}' used by worktree at '${w.worktreeUsing(name)}'`);
  }
  const id = w.mustResolve(start);
  l.branches.set(name, id);
  const lines = [];
  if (l.remoteRefs.has(start)) {
    l.upstream.set(name, start);
    lines.push(out(`branch '${name}' set up to track '${start}'.`));
  }
  lines.push(note(`Created branch '${name}' at ${w.short(id)}. HEAD is still on ${headLabel(w)}; use "git switch ${name}" to move onto it.`));
  return lines;
}

// ---- checkout / switch -----------------------------------------------------

/** Warn when leaving a detached HEAD that has commits no branch points to. */
function leaveDetached(w, newId) {
  const l = w.local;
  if (l.head.type !== 'detached') return [];
  const old = l.head.id;
  const keep = new Set();
  const others = w.otherWorktrees().map((t) => w.worktreeHeadId(t));
  for (const tip of [...l.branches.values(), ...l.remoteRefs.values(), ...others, newId]) {
    for (const id of w.ancestors(tip)) keep.add(id);
  }
  const lost = [...w.ancestors(old)].filter((id) => !keep.has(id)).sort((a, b) => w.commit(b).seq - w.commit(a).seq);
  if (!lost.length) return old === newId ? [] : [out(`Previous HEAD position was ${w.oneline(old)}`)];
  return [
    warn(`Warning: you are leaving ${plural(lost.length, 'commit')} behind, not connected to any of your branches:`),
    ...lost.slice(0, 4).map((id) => out(`  ${w.oneline(id)}`)),
    hint('If you want to keep them by creating a new branch, this may be a good time to do so with:'),
    hint(` git branch <new-branch-name> ${w.short(old)}`),
  ];
}

function attach(w, name) {
  w.local.head = { type: 'branch', name };
}

export function checkout(w, args, cmd = 'checkout') {
  const isSwitch = cmd === 'switch';
  const spec = isSwitch
    ? {
        '-c': { key: 'create', value: true },
        '--create': { key: 'create', value: true },
        '-C': { key: 'forceCreate', value: true },
        '-d': { key: 'detach' },
        '--detach': { key: 'detach' },
      }
    : {
        '-b': { key: 'create', value: true },
        '-B': { key: 'forceCreate', value: true },
        '--detach': { key: 'detach' },
      };
  Object.assign(spec, {
    '-t': { key: 'track' },
    '--track': { key: 'track' },
    '-f': { key: 'force' },
    '--force': { key: 'force' },
    '-q': { key: 'quiet' },
  });
  const { opts, pos } = parseOpts(args, spec);
  const l = w.local;

  const newName = opts.create ?? opts.forceCreate;
  if (newName) {
    assertBranchName(newName);
    const existed = l.branches.has(newName);
    if (existed && opts.create) throw new GitError(`fatal: a branch named '${newName}' already exists`);
    if (existed) assertNotInOtherWorktree(w, newName);
    const start = pos[0] ?? 'HEAD';
    const id = w.mustResolve(start);
    const lines = leaveDetached(w, id);
    l.branches.set(newName, id);
    attach(w, newName);
    if (l.remoteRefs.has(start)) {
      l.upstream.set(newName, start);
      lines.push(out(`branch '${newName}' set up to track '${start}'.`));
    }
    lines.push(out(existed ? `Switched to and reset branch '${newName}'` : `Switched to a new branch '${newName}'`));
    return lines;
  }

  if (!pos.length) {
    if (isSwitch) throw new GitError('fatal: missing branch or commit argument');
    const cur = w.currentBranch();
    return cur ? trackingInfo(w, cur) : [];
  }
  const target = pos[0];

  if (!opts.detach && l.branches.has(target)) {
    if (w.currentBranch() === target) return [out(`Already on '${target}'`), ...trackingInfo(w, target)];
    assertNotInOtherWorktree(w, target);
    const lines = leaveDetached(w, l.branches.get(target));
    attach(w, target);
    return [...lines, out(`Switched to branch '${target}'`), ...trackingInfo(w, target)];
  }

  // DWIM: "git switch feature" when only origin/feature exists creates a tracking branch.
  const remoteRef = `${REMOTE}/${target}`;
  if (!opts.detach && l.remoteRefs.has(remoteRef) && isValidBranchName(target)) {
    const id = l.remoteRefs.get(remoteRef);
    const lines = leaveDetached(w, id);
    l.branches.set(target, id);
    l.upstream.set(target, remoteRef);
    attach(w, target);
    return [
      ...lines,
      out(`branch '${target}' set up to track '${remoteRef}'.`),
      out(`Switched to a new branch '${target}'`),
      note(`Git created a local branch '${target}' from '${remoteRef}' for you.`),
    ];
  }

  const id = w.resolve(target);
  if (!id) {
    throw new GitError(
      isSwitch
        ? `fatal: invalid reference: ${target}`
        : `error: pathspec '${target}' did not match any file(s) known to git`,
    );
  }
  if (isSwitch && !opts.detach) {
    throw new GitError([
      `fatal: a branch is expected, got commit '${target}'`,
      { kind: 'hint', text: 'hint: If you want to detach HEAD at the commit, try again with the --detach option.' },
    ]);
  }
  const lines = leaveDetached(w, id);
  l.head = { type: 'detached', id };
  return [
    ...lines,
    out(`Note: switching to '${target}'.`),
    out(''),
    warn(`You are in 'detached HEAD' state. You can look around, make experimental changes and commit them,`),
    warn(`and you can discard any commits you make in this state without impacting any branches by switching back to a branch.`),
    out(''),
    out(`HEAD is now at ${w.oneline(id)}`),
  ];
}

// ---- merge -----------------------------------------------------------------

export function merge(w, args) {
  const { opts, pos } = parseOpts(args, {
    '--no-ff': { key: 'noFF' },
    '--ff-only': { key: 'ffOnly' },
    '--ff': { key: 'ff' },
    '-m': { key: 'message', value: true },
    '--no-edit': { key: 'noEdit' },
    '--abort': { key: 'abort' },
  });
  if (opts.abort) throw new GitError('fatal: There is no merge to abort (MERGE_HEAD missing).');
  let rev = pos[0];
  if (!rev) {
    const cur = w.currentBranch();
    rev = cur && w.local.upstream.get(cur);
    if (!rev) throw new GitError('fatal: No remote for the current branch.');
  }
  return doMerge(w, rev, opts);
}

export function doMerge(w, rev, { noFF, ffOnly, message } = {}) {
  const theirs = w.mustResolve(rev);
  const ours = w.headId();
  const label = headLabel(w);
  if (w.isAncestor(theirs, ours)) return [out('Already up to date.')];
  if (w.isAncestor(ours, theirs) && !noFF) {
    w.moveHead(theirs);
    return [
      out(`Updating ${w.short(ours)}..${w.short(theirs)}`),
      out('Fast-forward'),
      note(`Fast-forward: ${label} just slid forward to ${w.short(theirs)}. No merge commit was needed.`),
    ];
  }
  if (ffOnly) {
    throw new GitError([
      { kind: 'hint', text: "hint: Diverging branches can't be fast-forwarded, you need to either merge or rebase." },
      'fatal: Not possible to fast-forward, aborting.',
    ]);
  }
  const cur = w.currentBranch();
  const kind = w.local.remoteRefs.has(rev) ? 'remote-tracking branch' : w.local.branches.has(rev) ? 'branch' : 'commit';
  const into = cur && cur !== 'main' && cur !== 'master' ? ` into ${cur}` : '';
  const c = w.createCommit([ours, theirs], message ?? `Merge ${kind} '${rev}'${into}`);
  w.local.has.add(c.id);
  w.moveHead(c.id);
  return [
    out("Merge made by the 'ort' strategy."),
    note(`Created merge commit ${w.short(c.id)} with two parents: ${w.short(ours)} (${label}) and ${w.short(theirs)} (${rev}).`),
  ];
}

// ---- rebase ----------------------------------------------------------------

export function rebase(w, args) {
  const { opts, pos } = parseOpts(args, {
    '-i': { key: 'interactive' },
    '--interactive': { key: 'interactive' },
    '--onto': { key: 'onto', value: true },
    '--abort': { key: 'abort' },
    '--continue': { key: 'continue' },
    '--skip': { key: 'skip' },
  });
  if (opts.abort || opts.continue || opts.skip) throw new GitError('fatal: No rebase in progress?');
  if (opts.interactive) throw new GitError('error: interactive rebase (-i) is not supported in this visualizer.');
  const lines = [];
  if (pos[1]) lines.push(...checkout(w, [pos[1]], 'checkout'));
  let upstream = pos[0];
  if (!upstream) {
    const cur = w.currentBranch();
    upstream = cur && w.local.upstream.get(cur);
    if (!upstream) {
      throw new GitError([
        'There is no tracking information for the current branch.',
        'Please specify which branch you want to rebase against.',
        '',
        '    git rebase <branch>',
      ]);
    }
  }
  return [...lines, ...doRebase(w, upstream, opts.onto)];
}

export function doRebase(w, upstreamRev, ontoRev) {
  const up = w.mustResolve(upstreamRev);
  const onto = ontoRev ? w.mustResolve(ontoRev) : up;
  const head = w.headId();
  const cur = w.currentBranch();
  const done = out(`Successfully rebased and updated ${cur ? `refs/heads/${cur}` : 'detached HEAD'}.`);

  if (!ontoRev && w.isAncestor(up, head)) return [out(`Current branch ${cur ?? 'HEAD'} is up to date.`)];

  // Commits on our side only (merge commits are dropped, as git does by default).
  const todo = w.range(up, head).filter((id) => w.commit(id).parents.length < 2);
  // Skip commits whose change already exists on the new base (e.g. cherry-picked earlier).
  const applied = new Set([...w.ancestors(onto)].map((id) => patchOf(w.commit(id))));
  let base = onto;
  const replayed = [];
  let skipped = 0;
  for (const id of todo) {
    const old = w.commit(id);
    if (applied.has(patchOf(old))) {
      skipped++;
      continue;
    }
    const c = w.createCommit([base], old.message, old.author, { copiedFrom: id, patch: patchOf(old) });
    w.local.has.add(c.id);
    replayed.push([id, c.id]);
    base = c.id;
  }
  w.moveHead(base);

  const lines = [done];
  if (replayed.length) {
    lines.push(
      note(
        `Replayed ${plural(replayed.length, 'commit')} on top of ${ontoRev ?? upstreamRev}: ` +
          replayed.map(([a, b]) => `${w.short(a)} → ${w.short(b)}`).join(', ') +
          '. Rebasing creates NEW commits (new hashes); the originals are left behind.',
      ),
    );
  } else if (!skipped) {
    lines.push(note(`Nothing to replay: ${cur ?? 'HEAD'} was fast-forwarded to ${upstreamRev}.`));
  }
  if (skipped) lines.push(note(`Skipped ${plural(skipped, 'commit')} that ${skipped === 1 ? 'was' : 'were'} already upstream.`));
  return lines;
}

// ---- reset / cherry-pick / revert -----------------------------------------

export function reset(w, args) {
  const { opts, pos } = parseOpts(args, {
    '--soft': { key: 'soft' },
    '--mixed': { key: 'mixed' },
    '--hard': { key: 'hard' },
    '-q': { key: 'quiet' },
  });
  const old = w.headId();
  const id = w.mustResolve(pos[0] ?? 'HEAD');
  w.moveHead(id);
  const lines = [];
  if (opts.hard) lines.push(out(`HEAD is now at ${w.oneline(id)}`));
  if (old !== id) {
    const mode = opts.hard ? '--hard' : opts.soft ? '--soft' : '--mixed';
    lines.push(
      note(
        `${headLabel(w)} moved from ${w.short(old)} to ${w.short(id)}.` +
          (mode === '--hard' ? '' : ` (${mode} would keep your file changes; only the graph is shown here.)`),
      ),
    );
  }
  return lines;
}

export function cherryPick(w, args) {
  const { pos } = parseOpts(args, { '-x': { key: 'x' }, '--abort': { key: 'abort' } });
  if (!pos.length) throw new GitError('fatal: empty commit set passed');
  const lines = [];
  for (const rev of pos) {
    const src = w.commit(w.mustResolve(rev));
    if (src.parents.length > 1) throw new GitError(`error: commit ${w.short(src.id)} is a merge but no -m option was given.`);
    const c = w.createCommit([w.headId()], src.message, src.author, { copiedFrom: src.id, patch: patchOf(src) });
    w.local.has.add(c.id);
    w.moveHead(c.id);
    lines.push(out(`[${headLabel(w)} ${w.short(c.id)}] ${c.message.split('\n')[0]}`));
  }
  lines.push(note('Cherry-pick copies the change as a new commit with a new hash.'));
  return lines;
}

export function revert(w, args) {
  const { pos } = parseOpts(args, { '--no-edit': { key: 'noEdit' } });
  if (!pos.length) throw new GitError('fatal: empty commit set passed');
  const lines = [];
  for (const rev of pos) {
    const src = w.commit(w.mustResolve(rev));
    const c = w.createCommit([w.headId()], `Revert "${src.message.split('\n')[0]}"`);
    w.local.has.add(c.id);
    w.moveHead(c.id);
    lines.push(out(`[${headLabel(w)} ${w.short(c.id)}] ${c.message}`));
  }
  return lines;
}

// ---- read-only: log / status ------------------------------------------------

export function log(w, args) {
  const { opts, pos } = parseOpts(args, {
    '--oneline': { key: 'oneline' },
    '--all': { key: 'all' },
    '--graph': { key: 'graph' },
    '--decorate': { key: 'decorate' },
    '-n': { key: 'n', value: true },
    '--max-count': { key: 'n', value: true },
  });
  const l = w.local;
  const tips = opts.all
    ? [w.headId(), ...l.branches.values(), ...l.remoteRefs.values()]
    : [w.mustResolve(pos[0] ?? 'HEAD')];
  const ids = new Set();
  for (const t of tips) for (const id of w.ancestors(t)) ids.add(id);
  const limit = opts.n ? Number(opts.n) : 50;
  const sorted = [...ids].sort((a, b) => w.commit(b).seq - w.commit(a).seq).slice(0, limit);
  const lines = [];
  for (const id of sorted) {
    const c = w.commit(id);
    const deco = decorations(w, id);
    const d = deco.length ? ` (${deco.join(', ')})` : '';
    if (opts.oneline) {
      lines.push({ kind: 'log', text: `${w.short(id)}${d} ${c.message.split('\n')[0]}` });
    } else {
      lines.push({ kind: 'log', text: `commit ${id}${d}` });
      if (c.parents.length > 1) lines.push(out(`Merge: ${c.parents.map((p) => w.short(p)).join(' ')}`));
      lines.push(out(`Author: ${c.author}`), out(''), ...c.message.split('\n').map((m) => out(`    ${m}`)), out(''));
    }
  }
  return lines;
}

export function status(w) {
  const cur = w.currentBranch();
  const lines = cur ? [out(`On branch ${cur}`), ...trackingInfo(w, cur)] : [warn(`HEAD detached at ${w.short(w.headId())}`)];
  lines.push(out(''), out('nothing to commit, working tree clean'));
  if (cur && w.local.upstream.has(cur)) {
    lines.push(note('Status compares against origin/* as of your last fetch; run "git fetch" to refresh it.'));
  }
  return lines;
}
