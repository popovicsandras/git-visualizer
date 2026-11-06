import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, run, quickAction, QUICK_ACTIONS } from '../public/git/index.js';

const setup = () => new World({ seed: 7 });

function ok(w, ...cmds) {
  for (const c of cmds) {
    const r = run(w, c);
    assert.ok(r.ok, `"${c}" failed:\n${r.lines.map((l) => l.text).join('\n')}`);
  }
}

/** Run what a button would run, failing if it can't run or git rejects it. */
function click(w, kind) {
  const { cmd, reason } = quickAction(w, kind);
  assert.ok(cmd, `${kind} is unavailable: ${reason}`);
  ok(w, cmd);
  return cmd;
}

const cmds = (w) => Object.fromEntries(QUICK_ACTIONS.map((k) => [k, quickAction(w, k).cmd]));

test('on a cloned main, every action is the plain default command', () => {
  assert.deepEqual(cmds(setup()), {
    commit: 'git commit',
    rebase: 'git rebase',
    fetch: 'git fetch',
    pull: 'git pull',
    push: 'git push',
    'force-push': 'git push -f',
  });
});

test('a branch without an upstream is published and rebased explicitly', () => {
  const w = setup();
  ok(w, 'git checkout -b feature');
  assert.deepEqual(cmds(w), {
    commit: 'git commit',
    rebase: 'git rebase origin/main',
    fetch: 'git fetch',
    pull: null, // not on origin yet
    push: 'git push -u origin feature',
    'force-push': 'git push -u -f origin feature',
  });
  assert.match(quickAction(w, 'pull').reason, /no feature on origin/);
  click(w, 'commit');
  click(w, 'push');
  assert.equal(w.local.upstream.get('feature'), 'origin/feature');
  assert.equal(w.remote.branches.get('feature'), w.headId());
  assert.equal(quickAction(w, 'push').cmd, 'git push');
  assert.equal(quickAction(w, 'pull').cmd, 'git pull');
  assert.equal(quickAction(w, 'force-push').cmd, 'git push -f');
  assert.equal(quickAction(w, 'rebase').cmd, 'git rebase origin/main');
});

test('force push succeeds where a rewritten branch is rejected', () => {
  const w = setup();
  ok(w, 'git checkout -b feature');
  click(w, 'commit');
  click(w, 'push');
  ok(w, 'git reset --hard HEAD~1');
  click(w, 'commit');
  assert.equal(run(w, quickAction(w, 'push').cmd).ok, false);
  click(w, 'force-push');
  assert.equal(w.remote.branches.get('feature'), w.headId());
});

test('rebase replays the current branch onto origin/main; pull and fetch bring in remote work', () => {
  const w = setup();
  ok(w, 'git checkout -b feature');
  click(w, 'commit');
  ok(w, 'remote commit main');
  click(w, 'fetch');
  const target = w.local.remoteRefs.get('origin/main');
  click(w, 'rebase');
  assert.deepEqual(w.commit(w.headId()).parents, [target]);

  ok(w, 'git checkout main');
  click(w, 'pull');
  assert.equal(w.headId(), target);
});

test('rebase falls back to local main when there is no origin/main', () => {
  const w = setup();
  ok(w, 'git checkout -b feature');
  w.local.remoteRefs.delete('origin/main');
  assert.equal(quickAction(w, 'rebase').cmd, 'git rebase main');
  click(w, 'rebase');

  ok(w, 'git checkout main');
  w.local.upstream.delete('main');
  const a = quickAction(w, 'rebase');
  assert.equal(a.cmd, null);
  assert.match(a.reason, /no upstream/);
});

test('on a detached HEAD only commit and fetch are available', () => {
  const w = setup();
  ok(w, 'git checkout HEAD~1');
  assert.equal(quickAction(w, 'commit').cmd, 'git commit');
  assert.equal(quickAction(w, 'fetch').cmd, 'git fetch');
  for (const kind of ['pull', 'push', 'force-push', 'rebase']) {
    const a = quickAction(w, kind);
    assert.equal(a.cmd, null);
    assert.match(a.reason, /detached/);
  }
});

test('a branch on origin without an upstream pulls from it explicitly', () => {
  const w = setup();
  ok(w, 'git checkout -b feature', 'git push origin feature');
  assert.equal(w.local.upstream.get('feature'), undefined);
  assert.equal(quickAction(w, 'pull').cmd, 'git pull origin feature');
  click(w, 'pull');
});

test('actions follow the worktree the prompt is in', () => {
  const w = setup();
  ok(w, 'git worktree add -b hotfix ../project-hotfix main', 'cd ../project-hotfix');
  assert.equal(quickAction(w, 'push').cmd, 'git push -u origin hotfix');
  click(w, 'commit');
  click(w, 'push');
  assert.equal(w.remote.branches.get('hotfix'), w.headId());
  ok(w, 'cd -');
  assert.equal(quickAction(w, 'push').cmd, 'git push');
});
