// One-click actions (the button rail): the git command each would run right now.
// They act on the current branch of the worktree the prompt is in (fetch: the whole remote).

import { DEFAULT_BRANCH, REMOTE } from './world.js';

export const QUICK_ACTIONS = ['commit', 'rebase', 'fetch', 'pull', 'push', 'force-push'];

const VERB = { pull: 'pull', push: 'push', 'force-push': 'force push', rebase: 'rebase' };

/**
 * What `kind` would do in this world:
 *   { cmd, detail }          the command line to run, and a sentence about what it does
 *   { cmd: null, reason }    it can't run right now, and why
 */
export function quickAction(w, kind) {
  const cur = w.currentBranch();
  if (kind === 'fetch') {
    return {
      cmd: 'git fetch',
      detail: `Download what's new on ${REMOTE} and move your ${REMOTE}/* branches. Your own branches stay put.`,
    };
  }
  if (kind === 'commit') {
    return { cmd: 'git commit', detail: `Record a new commit on ${cur ?? 'the detached HEAD'}.` };
  }
  if (!Object.hasOwn(VERB, kind)) throw new Error(`unknown quick action: ${kind}`);
  if (!cur) return { cmd: null, reason: `HEAD is detached, so there is no branch to ${VERB[kind]}. Check out a branch first.` };

  const up = w.local.upstream.get(cur); // 'origin/<name>' or undefined
  const dst = up ? up.slice(REMOTE.length + 1) : cur;
  switch (kind) {
    case 'pull':
      // pull asks origin directly, so it's fair to check origin itself, not just origin/*.
      if (!w.remote.branches.has(dst)) {
        return { cmd: null, reason: `There is no ${dst} on ${REMOTE} to pull from. Push ${cur} first.` };
      }
      return {
        cmd: up ? 'git pull' : `git pull ${REMOTE} ${cur}`,
        detail: `Fetch, then merge ${REMOTE}/${dst} into ${cur}.`,
      };
    case 'push':
      return up
        ? { cmd: 'git push', detail: `Send ${cur}'s new commits to ${dst} on ${REMOTE}.` }
        : { cmd: `git push -u ${REMOTE} ${cur}`, detail: `Publish ${cur} to ${REMOTE} and make ${REMOTE}/${cur} its upstream.` };
    case 'force-push':
      return {
        cmd: up ? 'git push -f' : `git push -u -f ${REMOTE} ${cur}`,
        detail: `Make ${dst} on ${REMOTE} match your ${cur}, even if that throws away commits there. Everyone in the session sees it.`,
      };
    case 'rebase':
      return rebaseAction(w, cur, up);
  }
}

/**
 * Rebase onto the default branch as origin has it (as of your last fetch). On the default
 * branch itself that is its upstream, so plain `git rebase` does it.
 */
function rebaseAction(w, cur, up) {
  const tracking = `${REMOTE}/${DEFAULT_BRANCH}`;
  if (cur === DEFAULT_BRANCH) {
    if (up) return { cmd: 'git rebase', detail: `Replay ${cur}'s own commits on top of ${up} (as of your last fetch).` };
    if (w.local.remoteRefs.has(tracking)) {
      return { cmd: `git rebase ${tracking}`, detail: `Replay ${cur}'s own commits on top of ${tracking} (as of your last fetch).` };
    }
    return { cmd: null, reason: `${cur} has no upstream, so there is nothing to rebase it onto.` };
  }
  if (w.local.remoteRefs.has(tracking)) {
    return { cmd: `git rebase ${tracking}`, detail: `Replay ${cur}'s own commits on top of ${tracking} (as of your last fetch).` };
  }
  if (w.local.branches.has(DEFAULT_BRANCH)) {
    return { cmd: `git rebase ${DEFAULT_BRANCH}`, detail: `Replay ${cur}'s own commits on top of ${DEFAULT_BRANCH}.` };
  }
  return { cmd: null, reason: `There is no ${DEFAULT_BRANCH} or ${tracking} to rebase ${cur} onto.` };
}
