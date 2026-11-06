import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, run } from '../public/git/index.js';
import { tokenize, parseOpts } from '../public/git/parse.js';
import { layout } from '../public/layout.js';

function setup() {
  return new World({ seed: 42 });
}

/** Run commands, failing the test if any of them errors. */
function ok(w, ...cmds) {
  for (const c of cmds) {
    const r = run(w, c);
    assert.ok(r.ok, `"${c}" failed:\n${r.lines.map((l) => l.text).join('\n')}`);
  }
}

const text = (r) => r.lines.map((l) => l.text).join('\n');

test('tokenizer handles quotes and combined flags', () => {
  assert.deepEqual(tokenize(`git commit -am "fix the 'thing'"`), ['git', 'commit', '-am', "fix the 'thing'"]);
  const { opts } = parseOpts(['-am', 'msg'], { '-a': { key: 'a' }, '-m': { key: 'm', value: true } });
  assert.deepEqual(opts, { a: true, m: 'msg' });
});

test('starts as a fresh clone', () => {
  const w = setup();
  assert.equal(w.currentBranch(), 'main');
  assert.equal(w.local.remoteRefs.get('origin/main'), w.headId());
  assert.equal(w.remote.branches.get('main'), w.headId());
  const history = [...w.ancestors(w.headId())];
  assert.equal(history.length, 3, 'main starts with three commits');
  assert.deepEqual([...w.remote.has].sort(), history.sort(), 'same three commits on origin');
});

test('commit advances the current branch only', () => {
  const w = setup();
  const before = w.headId();
  ok(w, 'git commit -m "one"');
  assert.notEqual(w.headId(), before);
  assert.deepEqual(w.commit(w.headId()).parents, [before]);
  assert.equal(w.local.remoteRefs.get('origin/main'), before);
});

test('branch creation does not move HEAD; checkout -b does', () => {
  const w = setup();
  ok(w, 'git branch feature');
  assert.equal(w.currentBranch(), 'main');
  ok(w, 'git checkout -b other');
  assert.equal(w.currentBranch(), 'other');
  assert.equal(run(w, 'git branch feature').ok, false);
});

test('push without upstream is rejected, push -u works', () => {
  const w = setup();
  ok(w, 'git switch -c feature', 'git commit');
  const r = run(w, 'git push');
  assert.equal(r.ok, false);
  assert.match(text(r), /has no upstream branch/);
  ok(w, 'git push -u origin feature');
  assert.equal(w.remote.branches.get('feature'), w.headId());
  assert.equal(w.local.upstream.get('feature'), 'origin/feature');
});

test('rejected push, then pull --rebase, then push succeeds', () => {
  const w = setup();
  ok(w, 'remote commit main -m teammate', 'git commit -m mine');
  const mine = w.headId();
  const r = run(w, 'git push');
  assert.equal(r.ok, false);
  assert.match(text(r), /rejected.*fetch first/);

  ok(w, 'git pull --rebase');
  const head = w.headId();
  assert.notEqual(head, mine, 'rebase must create a new commit');
  assert.equal(w.commit(head).copiedFrom, mine);
  assert.equal(w.commit(head).parents[0], w.remote.branches.get('main'));
  assert.ok(!w.reachable('local').has(mine), 'original commit becomes unreachable');

  ok(w, 'git push');
  assert.equal(w.remote.branches.get('main'), head);
});

test('pull fast-forwards when there is nothing local', () => {
  const w = setup();
  ok(w, 'remote commit', 'git pull');
  assert.equal(w.headId(), w.remote.branches.get('main'));
  assert.equal(w.commit(w.headId()).parents.length, 1);
});

test('pull with diverged history creates a merge commit', () => {
  const w = setup();
  ok(w, 'remote commit', 'git commit', 'git pull');
  assert.equal(w.commit(w.headId()).parents.length, 2);
  ok(w, 'git push');
});

test('checkout -b, commit, rebase main', () => {
  const w = setup();
  ok(w, 'git checkout -b feature', 'git commit -m f1', 'git commit -m f2', 'git checkout main', 'git commit -m m1');
  const m1 = w.headId();
  ok(w, 'git checkout feature', 'git rebase main');
  const log = w.range(m1, w.headId()).map((id) => w.commit(id).message);
  assert.deepEqual(log, ['f1', 'f2']);
  assert.ok(w.isAncestor(m1, w.headId()));
  assert.match(text(run(w, 'git rebase main')), /up to date/);
});

test('merge: fast-forward, then a true merge', () => {
  const w = setup();
  ok(w, 'git checkout -b feature', 'git commit', 'git checkout main', 'git merge feature');
  assert.equal(w.headId(), w.local.branches.get('feature'));
  ok(w, 'git checkout feature', 'git commit', 'git checkout main', 'git commit', 'git merge feature');
  assert.equal(w.commit(w.headId()).parents.length, 2);
});

test('detached HEAD commits are reported as left behind', () => {
  const w = setup();
  ok(w, 'git commit', 'git checkout HEAD~1');
  assert.equal(w.currentBranch(), null);
  ok(w, 'git commit -m lost');
  const r = run(w, 'git switch main');
  assert.match(text(r), /leaving 1 commit behind/);
});

test('fetch updates origin/* but not local branches', () => {
  const w = setup();
  const main = w.headId();
  ok(w, 'remote commit', 'remote branch hotfix', 'git fetch');
  assert.equal(w.local.branches.get('main'), main);
  assert.equal(w.local.remoteRefs.get('origin/main'), w.remote.branches.get('main'));
  assert.ok(w.local.remoteRefs.has('origin/hotfix'));
  ok(w, 'git checkout hotfix');
  assert.equal(w.local.upstream.get('hotfix'), 'origin/hotfix');
});

test('force push overwrites remote history', () => {
  const w = setup();
  ok(w, 'git commit', 'git push', 'git reset --hard HEAD~1', 'git commit -m other');
  assert.equal(run(w, 'git push').ok, false);
  ok(w, 'git push -f');
  assert.equal(w.remote.branches.get('main'), w.headId());
});

test('branch -d refuses unmerged branches, -D forces', () => {
  const w = setup();
  ok(w, 'git checkout -b tmp', 'git commit', 'git checkout main');
  assert.equal(run(w, 'git branch -d tmp').ok, false);
  ok(w, 'git branch -D tmp');
  assert.ok(!w.local.branches.has('tmp'));
});

test('undo restores the previous state; errors do not create undo steps', () => {
  const w = setup();
  const start = w.headId();
  ok(w, 'git commit');
  run(w, 'git checkout nope');
  ok(w, 'undo');
  assert.equal(w.headId(), start);
});

test('unknown commands give helpful errors', () => {
  const w = setup();
  assert.match(text(run(w, 'commit')), /Did you mean "git commit"/);
  assert.match(text(run(w, 'git frobnicate')), /not a git command/);
});

test('layout: main stays on lane 0, columns shared across panels, lanes stable', () => {
  const w = setup();
  ok(w, 'git checkout -b feature', 'git commit', 'git checkout main', 'git commit', 'git push');
  const a = layout(w);
  const lanes = new Map(a.local.nodes.map((n) => [n.id, n.lane]));
  assert.equal(lanes.get(w.local.branches.get('main')), 0);
  assert.equal(lanes.get(w.local.branches.get('feature')), 1);
  for (const n of a.remote.nodes) {
    assert.equal(n.col, a.local.nodes.find((m) => m.id === n.id).col);
  }
  ok(w, 'git checkout feature', 'git commit');
  const b = layout(w);
  for (const n of a.local.nodes) assert.equal(b.local.nodes.find((m) => m.id === n.id).lane, n.lane);
});

test('worktree add creates a branch in a new folder', () => {
  const w = setup();
  const main = w.headId();
  ok(w, 'git worktree add -b feature ../project-feature main');
  assert.equal(w.local.branches.get('feature'), main);
  assert.deepEqual(w.local.worktrees.get('~/project-feature').head, { type: 'branch', name: 'feature' });
  assert.equal(w.currentBranch(), 'main', 'the prompt stays in the main worktree');
  assert.match(text(run(w, 'git worktree list')), /~\/project\s+\w+ \[main\]\n~\/project-feature\s+\w+ \[feature\]/);
});

test('a branch checked out in a worktree is protected', () => {
  const w = setup();
  ok(w, 'git worktree add -b feature ../wt');
  for (const cmd of ['git checkout feature', 'git switch feature', 'git branch -D feature', 'git branch -f feature HEAD~1', 'git worktree add ../other feature']) {
    const r = run(w, cmd);
    assert.equal(r.ok, false, `${cmd} should fail`);
    assert.match(text(r), /worktree at '~\/wt'/);
  }
  assert.equal(run(w, 'git worktree add -b feature ../again').ok, false, 'branch already exists');
  assert.equal(run(w, 'git worktree add -b x ../wt').ok, false, 'folder already exists');
  assert.equal(run(w, 'git worktree add ../main-again main').ok, false, 'main is checked out in ~/project');
  ok(w, 'git branch -m feature renamed');
  assert.deepEqual(w.local.worktrees.get('~/wt').head, { type: 'branch', name: 'renamed' });
});

test('worktree remove keeps the branch and supports undo', () => {
  const w = setup();
  ok(w, 'git worktree add -b feature ../project-feature');
  assert.equal(run(w, 'git worktree remove .').ok, false, 'cannot remove the main worktree');
  ok(w, 'git worktree remove project-feature');
  assert.deepEqual([...w.local.worktrees.keys()], ['~/project']);
  assert.ok(w.local.branches.has('feature'));
  ok(w, 'git checkout feature');
  ok(w, 'git checkout main', 'undo', 'undo', 'undo');
  assert.ok(w.local.worktrees.has('~/project-feature'), 'undo restores the worktree');
});

test('detached worktree HEAD keeps commits reachable and is labelled', () => {
  const w = setup();
  ok(w, 'git commit', 'git worktree add --detach ../scratch HEAD', 'git reset --hard HEAD~1');
  const tip = w.local.worktrees.get('~/scratch').head.id;
  assert.ok(w.reachable('local').has(tip));
  const node = layout(w).local.nodes.find((n) => n.id === tip);
  assert.ok(node.labels.some((l) => l.type === 'worktree' && l.text === 'HEAD (scratch)'));
});

test('cd switches the active worktree and its HEAD', () => {
  const w = setup();
  const base = w.headId();
  ok(w, 'git worktree add -b feature ../project-feature', 'cd ../project-feature');
  assert.equal(w.cwd, '~/project-feature');
  assert.equal(w.currentBranch(), 'feature');
  assert.equal(text(run(w, 'pwd')), '~/project-feature');
  ok(w, 'git commit -m "on feature"');
  assert.notEqual(w.local.branches.get('feature'), base);
  assert.equal(w.local.branches.get('main'), base, 'main did not move');
  // main is now checked out elsewhere, so it is protected from here.
  const r = run(w, 'git switch main');
  assert.equal(r.ok, false);
  assert.match(text(r), /worktree at '~\/project'/);
  // Labels follow the prompt.
  const labels = layout(w).local.nodes.flatMap((n) => n.labels);
  assert.ok(labels.some((l) => l.type === 'current' && l.ref === 'feature'));
  assert.ok(labels.some((l) => l.type === 'worktree' && l.ref === 'main'));
  // Paths are relative to the new folder.
  assert.equal(run(w, 'git worktree remove .').ok, false, 'cannot remove the current worktree');
  ok(w, 'git worktree add -b other ../project-other', 'cd -');
  assert.equal(w.cwd, '~/project');
  assert.equal(w.currentBranch(), 'main');
  assert.equal(run(w, 'cd project-other').ok, false, 'relative to ~/project, like a real shell');
  ok(w, 'cd ../project-other');
  assert.equal(w.currentBranch(), 'other');
  assert.equal(run(w, 'cd ../nope').ok, false);
  assert.equal(run(w, 'cd').ok, false);
  ok(w, 'cd ../project', 'git worktree remove ../project-feature');
  assert.ok(w.local.branches.has('feature'));
});

test('undo reverts cd', () => {
  const w = setup();
  ok(w, 'git worktree add -b feature ../wt', 'cd ../wt', 'git switch --detach HEAD');
  ok(w, 'undo', 'undo');
  assert.equal(w.cwd, '~/project');
  assert.equal(w.currentBranch(), 'main');
  assert.deepEqual(w.local.worktrees.get('~/wt').head, { type: 'branch', name: 'feature' });
});
