// Pure graph layout: assigns each commit a column (time) and a lane (row).
//
// - Columns are shared by both panels (ordered by creation), so the same commit
//   sits at the same x position in "local" and "remote".
// - Lane 0 is reserved for main's first-parent history.
// - Lanes are assigned oldest-first and depend only on older commits, so adding
//   a commit never moves existing ones.

export function layout(w) {
  const all = [...new Set([...w.local.has, ...w.remote.has])].sort((a, b) => w.commit(a).seq - w.commit(b).seq);
  const col = new Map(all.map((id, i) => [id, i]));
  return {
    columns: all.length,
    local: panelLayout(w, 'local', col),
    remote: panelLayout(w, 'remote', col),
  };
}

function panelLayout(w, which, col) {
  const repo = w.state[which];
  const ids = [...repo.has].sort((a, b) => w.commit(a).seq - w.commit(b).seq);
  const reachable = w.reachable(which);

  const mainTip = repo.branches.get('main') ?? (which === 'local' ? repo.remoteRefs.get('origin/main') : undefined);
  const mainChain = new Set();
  for (let id = mainTip; id; id = w.commit(id).parents[0]) mainChain.add(id);
  const minLane = mainChain.size ? 1 : 0;

  // A merge edge runs along its parent's lane until the merge commit; reserve that space.
  const mergeReach = new Map();
  for (const id of ids) {
    for (const p of w.commit(id).parents.slice(1)) {
      mergeReach.set(p, Math.max(mergeReach.get(p) ?? -1, col.get(id)));
    }
  }

  const lane = new Map();
  const laneEnd = [];
  const laneTip = [];
  for (const id of ids) {
    const p = w.commit(id).parents[0];
    let L;
    if (mainChain.has(id)) {
      L = 0;
    } else if (p !== undefined && lane.get(p) >= minLane && laneTip[lane.get(p)] === p) {
      L = lane.get(p); // continue the parent's line
    } else {
      const start = p !== undefined ? col.get(p) : col.get(id);
      L = minLane;
      while (laneEnd[L] !== undefined && laneEnd[L] >= start) L++;
    }
    lane.set(id, L);
    laneTip[L] = id;
    laneEnd[L] = Math.max(laneEnd[L] ?? -1, col.get(id), mergeReach.get(id) ?? -1);
  }

  const labels = new Map(); // id -> [{ text, type }]
  const add = (id, label) => {
    if (!labels.has(id)) labels.set(id, []);
    labels.get(id).push(label);
  };
  if (which === 'local') {
    const h = repo.head;
    if (h.type === 'detached') add(h.id, { text: 'HEAD', type: 'detached', ref: 'HEAD' });
    for (const t of w.otherWorktrees()) {
      if (t.head.type === 'detached') {
        add(t.head.id, { text: `HEAD (${t.path.slice(t.path.lastIndexOf('/') + 1)})`, type: 'worktree', ref: `wt:${t.path}` });
      }
    }
    for (const [name, id] of [...repo.branches].sort()) {
      const current = h.type === 'branch' && h.name === name;
      // Checked out in another worktree: that folder's HEAD → name.
      const elsewhere = !current && w.worktreeUsing(name);
      add(id, {
        text: current ? `HEAD → ${name}` : name,
        type: current ? 'current' : elsewhere ? 'worktree' : 'branch',
        ref: name,
      });
    }
    for (const [name, id] of [...repo.remoteRefs].sort()) add(id, { text: name, type: 'tracking', ref: name });
  } else {
    for (const [name, id] of [...repo.branches].sort()) add(id, { text: name, type: 'branch', ref: name });
  }

  const headId = which === 'local' ? w.headId() : null;
  const nodes = ids.map((id) => {
    const c = w.commit(id);
    return {
      id,
      col: col.get(id),
      lane: lane.get(id),
      message: c.message.split('\n')[0],
      author: c.author,
      copiedFrom: c.copiedFrom,
      parents: c.parents,
      faded: !reachable.has(id),
      isHead: id === headId,
      labels: labels.get(id) ?? [],
    };
  });
  const edges = [];
  for (const n of nodes) {
    n.parents.forEach((p, i) => edges.push({ from: p, to: n.id, merge: i > 0, faded: n.faded }));
  }
  const lanes = nodes.reduce((m, n) => Math.max(m, n.lane + 1), 1);
  return { nodes, edges, lanes };
}
