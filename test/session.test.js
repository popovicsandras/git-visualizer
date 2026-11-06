import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../server/session.js';
import { World } from '../public/git/index.js';
import { layout } from '../public/layout.js';

const text = (r) => r.lines.map((l) => l.text).join('\n');

function setup() {
  const s = new Session('test-test-test', { seed: 7 });
  const alice = s.addMember('Alice');
  const bob = s.addMember('Bob');
  const ok = (m, ...cmds) => {
    for (const c of cmds) {
      const r = s.run(m, c);
      assert.ok(r.ok, `${m.name}: "${c}" failed:\n${text(r)}`);
    }
  };
  return { s, alice, bob, ok };
}

test('every member starts as a clone of the same origin', () => {
  const { s, alice, bob } = setup();
  const main = s.origin.branches.get('main');
  assert.equal(alice.local.branches.get('main'), main);
  assert.equal(bob.local.branches.get('main'), main);
  assert.equal(s.shared.objects.size, 3);
  assert.equal(s.shared.objects.get(main).author, 'Alice', 'the creator authors the starting commits');
  assert.notEqual(alice.local, bob.local);
});

test('commits are private until pushed; a push is visible on origin but not in others\' origin/*', () => {
  const { s, alice, bob, ok } = setup();
  ok(alice, 'git commit -m "alice work"');
  const tip = alice.local.branches.get('main');
  assert.equal(s.shared.objects.get(tip).author, 'Alice');
  assert.ok(!bob.local.has.has(tip), 'Bob cannot see an unpushed commit');
  assert.ok(!s.view(bob).objects.some((c) => c.id === tip), 'nor is it sent to him');

  const r = s.run(alice, 'git push');
  assert.ok(r.ok);
  assert.deepEqual(r.activity.length, 1);
  assert.match(r.activity[0], /pushed 1 commit to origin\/main/);
  assert.equal(s.origin.branches.get('main'), tip);
  assert.notEqual(bob.local.remoteRefs.get('origin/main'), tip, "Bob's origin/main is stale until he fetches");

  ok(bob, 'git fetch');
  assert.equal(bob.local.remoteRefs.get('origin/main'), tip);
});

test('a concurrent push is rejected; pull --rebase then push works', () => {
  const { s, alice, bob, ok } = setup();
  ok(alice, 'git commit -m a', 'git push');
  ok(bob, 'git commit -m b');
  const r = s.run(bob, 'git push');
  assert.equal(r.ok, false);
  assert.match(text(r), /rejected.*fetch first/);
  assert.deepEqual(r.activity, []);
  ok(bob, 'git pull --rebase', 'git push');
  const main = s.origin.branches.get('main');
  assert.equal(s.shared.objects.get(main).author, 'Bob');
  assert.equal(s.shared.objects.get(main).parents[0], alice.local.branches.get('main'));
});

test('a late joiner clones origin as it is now, with every branch', () => {
  const { s, alice, ok } = setup();
  ok(alice, 'git switch -c feature', 'git commit', 'git push -u origin feature', 'git switch main', 'git commit', 'git push');
  const carol = s.addMember('Carol');
  assert.equal(carol.local.branches.get('main'), s.origin.branches.get('main'));
  assert.equal(carol.local.remoteRefs.get('origin/feature'), s.origin.branches.get('feature'));
  assert.ok(!carol.local.branches.has('feature'), 'like git clone: only main is checked out');
  ok(carol, 'git switch feature');
  assert.equal(carol.local.upstream.get('feature'), 'origin/feature');
});

test('undo rewinds your own repository but never origin', () => {
  const { s, alice, ok } = setup();
  const start = alice.local.branches.get('main');
  ok(alice, 'git commit', 'git push');
  const pushed = s.origin.branches.get('main');
  const r = s.run(alice, 'undo');
  assert.match(text(r), /origin stays as it is/);
  assert.equal(s.origin.branches.get('main'), pushed, 'origin keeps the push');
  assert.equal(alice.local.remoteRefs.get('origin/main'), start, 'origin/main goes back with the rest of the local repo');
  ok(alice, 'undo');
  assert.equal(alice.local.branches.get('main'), start);
  assert.match(text(s.run(alice, 'undo')), /Nothing to undo/);
});

test('re-clone replaces your repository and can be undone', () => {
  const { s, alice, ok } = setup();
  ok(alice, 'git switch -c mine', 'git commit');
  const mine = alice.local.branches.get('mine');
  s.reclone(alice);
  assert.ok(!alice.local.branches.has('mine'));
  assert.equal(alice.local.head.name, 'main');
  ok(alice, 'undo');
  assert.equal(alice.local.branches.get('mine'), mine);
});

test('the simulated teammate is off, and origin main cannot be deleted', () => {
  const { s, alice } = setup();
  const r = s.run(alice, 'remote commit main');
  assert.equal(r.ok, false);
  assert.match(text(r), /teammates are real people/);
  const del = s.run(alice, 'git push origin --delete main');
  assert.equal(del.ok, false);
  assert.match(text(del), /refusing to delete the current branch/);
  assert.ok(s.origin.branches.has('main'));
});

test('typed text cannot reach inherited properties', () => {
  const { s, alice } = setup();
  for (const cmd of ['git __proto__', 'git constructor', 'git toString', 'constructor', '__proto__']) {
    const r = s.run(alice, cmd);
    assert.equal(r.ok, false, cmd);
    assert.match(text(r), /not a git command|command not found/, cmd);
  }
});

test('force push and branch deletion are reported to others', () => {
  const { s, alice, bob, ok } = setup();
  ok(alice, 'git switch -c topic', 'git commit', 'git push -u origin topic');
  ok(bob, 'git fetch', 'git switch topic', 'git commit --amend -m rewritten');
  const forced = s.run(bob, 'git push -f');
  assert.match(forced.activity[0], /force-pushed origin\/topic/);
  const deleted = s.run(bob, 'git push origin --delete topic');
  assert.deepEqual(deleted.activity, ['deleted branch topic from origin']);
});

test('the view sent to a browser rebuilds into the same graph', () => {
  const { s, alice, bob, ok } = setup();
  ok(alice, 'git switch -c feature', 'git commit', 'git push -u origin feature');
  ok(bob, 'git worktree add -b wt ../wt', 'git commit', 'git fetch');
  const view = JSON.parse(JSON.stringify(s.view(bob)));
  const mirror = World.fromView(view, { author: 'Bob', shared: true });
  const original = new World({ state: { ...s.shared, local: bob.local } }); // Bob's live repo
  assert.deepEqual(layout(mirror), layout(original));
  assert.equal(mirror.headId(), bob.local.branches.get('main'));
  assert.deepEqual(mirror.worktreeList().map((t) => t.path), ['~/project', '~/wt']);
});
