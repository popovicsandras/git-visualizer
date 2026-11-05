// Commands that talk to the simulated "origin" remote, plus teammate simulation.

import { GitError, parseOpts } from './parse.js';
import { REMOTE, REMOTE_URL, isValidBranchName } from './world.js';
import { doMerge, doRebase, note, out } from './local.js';

const hintErr = (text) => ({ kind: 'hint', text: `hint: ${text}` });

function checkRemoteName(name) {
  if (name && name !== REMOTE) {
    throw new GitError([
      `fatal: '${name}' does not appear to be a git repository`,
      'fatal: Could not read from remote repository.',
    ]);
  }
}

/** Copy every commit reachable from `id` into the target repo's object store. */
function copyObjects(w, id, which) {
  for (const a of w.ancestors(id)) w.state[which].has.add(a);
}

const pad = (s) => s.padEnd(10);

// ---- fetch -----------------------------------------------------------------

export function fetch(w, args) {
  const { opts, pos } = parseOpts(args, {
    '-p': { key: 'prune' },
    '--prune': { key: 'prune' },
    '--all': { key: 'all' },
    '-q': { key: 'quiet' },
  });
  checkRemoteName(pos[0]);
  const lines = doFetch(w, opts);
  if (!lines.length) lines.push(note('Nothing new on origin: your origin/* branches were already current.'));
  return lines;
}

export function doFetch(w, { prune } = {}) {
  const l = w.local;
  const lines = [];
  for (const [name, id] of [...w.remote.branches].sort()) {
    copyObjects(w, id, 'local');
    const ref = `${REMOTE}/${name}`;
    const old = l.remoteRefs.get(ref);
    if (old === id) continue;
    if (!old) lines.push(out(` * [new branch]      ${pad(name)} -> ${ref}`));
    else if (w.isAncestor(old, id)) lines.push(out(`   ${w.short(old)}..${w.short(id)}  ${pad(name)} -> ${ref}`));
    else lines.push(out(` + ${w.short(old)}...${w.short(id)} ${pad(name)} -> ${ref}  (forced update)`));
    l.remoteRefs.set(ref, id);
  }
  if (prune) {
    for (const ref of [...l.remoteRefs.keys()].sort()) {
      if (!w.remote.branches.has(ref.slice(REMOTE.length + 1))) {
        l.remoteRefs.delete(ref);
        lines.push(out(` - [deleted]         ${pad('(none)')} -> ${ref}`));
      }
    }
  }
  if (lines.length) lines.unshift(out(`From ${REMOTE_URL}`));
  return lines;
}

// ---- pull ------------------------------------------------------------------

export function pull(w, args) {
  const { opts, pos } = parseOpts(args, {
    '-r': { key: 'rebase' },
    '--rebase': { key: 'rebase' },
    '--no-rebase': { key: 'noRebase' },
    '--ff-only': { key: 'ffOnly' },
    '--no-ff': { key: 'noFF' },
    '-q': { key: 'quiet' },
  });
  checkRemoteName(pos[0]);
  const cur = w.currentBranch();
  if (!cur) {
    throw new GitError([
      'You are not currently on a branch.',
      'Please specify which branch you want to merge with.',
    ]);
  }
  let upRef;
  if (pos[1]) {
    upRef = `${REMOTE}/${pos[1]}`;
  } else {
    upRef = w.local.upstream.get(cur);
    if (!upRef) {
      throw new GitError([
        'There is no tracking information for the current branch.',
        'Please specify which branch you want to merge with.',
        '',
        '    git pull <remote> <branch>',
        '',
        'If you wish to set tracking information for this branch you can do so with:',
        '',
        `    git branch --set-upstream-to=${REMOTE}/<branch> ${cur}`,
      ]);
    }
  }
  const remoteBranch = upRef.slice(REMOTE.length + 1);
  if (!w.remote.branches.has(remoteBranch)) throw new GitError(`fatal: couldn't find remote ref ${remoteBranch}`);

  const lines = doFetch(w);
  const ours = w.headId();
  const theirs = w.local.remoteRefs.get(upRef);
  const diverged = !w.isAncestor(ours, theirs) && !w.isAncestor(theirs, ours);
  if (opts.rebase && !opts.noRebase) {
    lines.push(...doRebase(w, upRef));
  } else {
    lines.push(...doMerge(w, upRef, opts));
    if (diverged) {
      lines.push(note('Your branch had diverged, so pull made a merge commit. "git pull --rebase" would replay your commits on top instead.'));
      lines.push(note('(Real git ≥ 2.33 stops here and asks you to pick --rebase or --no-rebase, unless pull.rebase is configured.)'));
    }
  }
  return lines;
}

// ---- push ------------------------------------------------------------------

export function push(w, args) {
  const { opts, pos } = parseOpts(args, {
    '-u': { key: 'setUpstream' },
    '--set-upstream': { key: 'setUpstream' },
    '-f': { key: 'force' },
    '--force': { key: 'force' },
    '--force-with-lease': { key: 'lease' },
    '-d': { key: 'delete' },
    '--delete': { key: 'delete' },
    '-q': { key: 'quiet' },
  });
  checkRemoteName(pos[0]);
  const l = w.local;
  const r = w.remote;
  const cur = w.currentBranch();

  if (opts.delete || pos[1]?.startsWith(':')) {
    const name = opts.delete ? pos[1] : pos[1].slice(1);
    if (!name) throw new GitError('fatal: --delete doesn\'t make sense without any refs');
    if (!r.branches.has(name)) {
      throw new GitError([`error: unable to delete '${name}': remote ref does not exist`, `error: failed to push some refs to '${REMOTE_URL}'`]);
    }
    r.branches.delete(name);
    l.remoteRefs.delete(`${REMOTE}/${name}`);
    return [out(`To ${REMOTE_URL}`), out(` - [deleted]         ${name}`)];
  }

  let src;
  let dst;
  if (pos[1]) {
    [src, dst] = pos[1].split(':');
    if (src === 'HEAD') src = cur ?? 'HEAD';
    dst ||= src;
  } else {
    if (!cur) {
      throw new GitError([
        'fatal: You are not currently on a branch.',
        'To push the history leading to the current (detached HEAD) state now, use',
        '',
        `    git push ${REMOTE} HEAD:<name-of-remote-branch>`,
      ]);
    }
    const up = l.upstream.get(cur);
    if (!up && !opts.setUpstream) {
      throw new GitError([
        `fatal: The current branch ${cur} has no upstream branch.`,
        'To push the current branch and set the remote as upstream, use',
        '',
        `    git push --set-upstream ${REMOTE} ${cur}`,
      ]);
    }
    src = cur;
    dst = up ? up.slice(REMOTE.length + 1) : cur;
  }
  if (!isValidBranchName(dst)) throw new GitError(`fatal: invalid destination '${dst}'`);
  const srcId = w.resolve(src);
  if (!srcId) throw new GitError([`error: src refspec ${src} does not match any`, `error: failed to push some refs to '${REMOTE_URL}'`]);

  const lines = [];
  const setUp = () => {
    if (opts.setUpstream && l.branches.has(src)) {
      l.upstream.set(src, `${REMOTE}/${dst}`);
      lines.push(out(`branch '${src}' set up to track '${REMOTE}/${dst}'.`));
    }
  };

  const old = r.branches.get(dst);
  if (old === srcId) {
    l.remoteRefs.set(`${REMOTE}/${dst}`, srcId);
    lines.push(out('Everything up-to-date'));
    setUp();
    return lines;
  }

  const fastForward = !old || w.isAncestor(old, srcId);
  let force = opts.force;
  if (opts.lease && !fastForward) {
    // --force-with-lease: only overwrite if the remote is where we last saw it.
    if (l.remoteRefs.get(`${REMOTE}/${dst}`) !== old) {
      throw new GitError([
        `To ${REMOTE_URL}`,
        ` ! [rejected]        ${src} -> ${dst} (stale info)`,
        `error: failed to push some refs to '${REMOTE_URL}'`,
        hintErr(`origin/${dst} is out of date: someone pushed since your last fetch. Fetch and look first.`),
      ]);
    }
    force = true;
  }

  if (!fastForward && !force) {
    const fetchFirst = !l.has.has(old);
    throw new GitError([
      `To ${REMOTE_URL}`,
      ` ! [rejected]        ${src} -> ${dst} (${fetchFirst ? 'fetch first' : 'non-fast-forward'})`,
      `error: failed to push some refs to '${REMOTE_URL}'`,
      ...(fetchFirst
        ? [
            hintErr('Updates were rejected because the remote contains work that you do not'),
            hintErr('have locally. You may want to first integrate the remote changes'),
            hintErr("(e.g., 'git pull ...') before pushing again."),
          ]
        : [
            hintErr('Updates were rejected because the tip of your current branch is behind'),
            hintErr("its remote counterpart. If you want to integrate the remote changes,"),
            hintErr("use 'git pull' before pushing again."),
          ]),
    ]);
  }

  copyObjects(w, srcId, 'remote');
  r.branches.set(dst, srcId);
  l.remoteRefs.set(`${REMOTE}/${dst}`, srcId);
  lines.push(out(`To ${REMOTE_URL}`));
  if (!old) lines.push(out(` * [new branch]      ${src} -> ${dst}`));
  else if (fastForward) lines.push(out(`   ${w.short(old)}..${w.short(srcId)}  ${src} -> ${dst}`));
  else {
    lines.push(out(` + ${w.short(old)}...${w.short(srcId)} ${src} -> ${dst} (forced update)`));
    lines.push(note(`Force push overwrote origin/${dst}. Commits only reachable from the old tip are now orphaned on the remote.`));
  }
  setUp();
  return lines;
}

// ---- git remote ------------------------------------------------------------

export function remoteCmd(w, args) {
  const { opts } = parseOpts(args, { '-v': { key: 'verbose' }, '--verbose': { key: 'verbose' } });
  if (opts.verbose) return [out(`${REMOTE}\t${REMOTE_URL} (fetch)`), out(`${REMOTE}\t${REMOTE_URL} (push)`)];
  return [out(REMOTE)];
}

// ---- teammate simulation (not a git command) ---------------------------------

export function teammate(w, args) {
  const [sub, ...rest] = args;
  const r = w.remote;
  if (sub === 'commit') {
    const { opts, pos } = parseOpts(rest, {
      '-m': { key: 'message', value: true },
      '--message': { key: 'message', value: true },
    });
    const name = pos[0] ?? 'main';
    const tip = r.branches.get(name);
    if (!tip) throw new GitError(`remote: origin has no branch '${name}'`);
    const c = w.createCommit([tip], opts.message ?? w.nextMessage(), 'teammate');
    r.has.add(c.id);
    r.branches.set(name, c.id);
    return [
      note(`A teammate pushed ${w.short(c.id)} "${c.message}" to ${name} on origin.`),
      note(`Your local ${REMOTE}/${name} doesn't know yet: run "git fetch" or "git pull" to see it.`),
    ];
  }
  if (sub === 'branch') {
    const [name, from = 'main'] = rest;
    if (!name || !isValidBranchName(name)) throw new GitError('usage: remote branch <name> [<from-branch>]');
    if (r.branches.has(name)) throw new GitError(`remote: origin already has a branch '${name}'`);
    const tip = r.branches.get(from);
    if (!tip) throw new GitError(`remote: origin has no branch '${from}'`);
    r.branches.set(name, tip);
    return [note(`A teammate created branch '${name}' on origin (from ${from}). Fetch to see it locally.`)];
  }
  throw new GitError([
    'usage: remote commit [<branch>] [-m <msg>]   simulate a teammate pushing a commit',
    '       remote branch <name> [<from>]          simulate a teammate pushing a new branch',
  ]);
}
