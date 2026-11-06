// Draws one panel's layout into an <svg>. Uses DOM APIs only (no innerHTML),
// so commit messages typed by users are always treated as text.

import { initials } from './people.js';

const NS = 'http://www.w3.org/2000/svg';
const R = 11; // node radius
const PAD_X = 48;
const PAD_TOP = 10;
const LABEL_H = 20;
const LABEL_GAP = 8;
const BELOW = 32; // room for hash + message under a node
const LANE_GAP = 8;
const CHAR_W = 7.3; // approx. width of a 12px monospace character
export const LANE_COLORS = 8;

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function text(parent, str, attrs) {
  const t = el('text', attrs, parent);
  t.textContent = str;
  return t;
}

/** Column width shared by both panels so they line up. */
export function columnWidth(layouts) {
  let longest = 7;
  for (const lay of layouts) for (const n of lay.nodes) for (const l of n.labels) longest = Math.max(longest, l.text.length);
  return Math.max(92, Math.round(longest * CHAR_W + 26));
}

function truncate(str, width) {
  const max = Math.max(4, Math.floor(width / 6.6));
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/**
 * Render a panel. `prev` holds what was drawn last time ({ nodes:Set, labels:Map })
 * so new commits and moved labels can be animated. Returns the new `prev` plus
 * the root group and the content size, for the pan/zoom controller.
 */
export function renderPanel(svg, lay, { columns, colW, prev, onNodeClick, me = 'you' }) {
  svg.replaceChildren();

  // Lane geometry: each lane gets enough headroom for its tallest label stack.
  const stack = new Array(lay.lanes).fill(0);
  for (const n of lay.nodes) stack[n.lane] = Math.max(stack[n.lane], n.labels.length);
  const laneY = [];
  let top = PAD_TOP;
  for (let L = 0; L < lay.lanes; L++) {
    const y = top + stack[L] * (LABEL_H + LABEL_GAP) + R + 4;
    laneY.push(y);
    top = y + R + BELOW + LANE_GAP;
  }
  const width = PAD_X * 2 + Math.max(0, columns - 1) * colW + colW / 2;
  const height = Math.max(top, 120);

  // Everything goes into one group that the pan/zoom controller transforms.
  const root = el('g', { class: 'camera' }, svg);
  const pos = new Map(lay.nodes.map((n) => [n.id, { x: PAD_X + n.col * colW, y: laneY[n.lane], lane: n.lane }]));

  // Lane guides (extend past the content so panning never shows their ends)
  const guides = el('g', { class: 'guides' }, root);
  for (let L = 0; L < lay.lanes; L++) {
    el('line', { x1: -10000, x2: width + 10000, y1: laneY[L], y2: laneY[L], class: 'guide' }, guides);
  }

  // Edges
  const edges = el('g', { class: 'edges' }, root);
  for (const e of lay.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    let d;
    let lane;
    if (a.y === b.y) {
      d = `M${a.x},${a.y} L${b.x},${b.y}`;
      lane = b.lane;
    } else if (!e.merge) {
      // Branching off: bend right after the parent, then run along the child's lane.
      const bx = Math.min(a.x + colW, b.x);
      const mx = (a.x + bx) / 2;
      d = `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${bx},${b.y} L${b.x},${b.y}`;
      lane = b.lane;
    } else {
      // Merging in: run along the parent's lane, bend just before the merge commit.
      const ax = Math.max(b.x - colW, a.x);
      const mx = (ax + b.x) / 2;
      d = `M${a.x},${a.y} L${ax},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
      lane = a.lane;
    }
    el('path', { d, class: `edge lane-${lane % LANE_COLORS}${e.faded ? ' faded' : ''}${e.merge ? ' merge' : ''}` }, edges);
  }

  // Nodes
  const nodesG = el('g', { class: 'nodes' }, root);
  const labelsG = el('g', { class: 'labels' }, root);
  const seen = new Set();
  const labelMap = new Map();
  for (const n of lay.nodes) {
    const { x, y } = pos.get(n.id);
    seen.add(n.id);
    const cls = [
      'node',
      `lane-${n.lane % LANE_COLORS}`,
      n.faded && 'faded',
      n.isHead && 'head',
      n.author !== me && 'teammate',
      prev && !prev.nodes.has(n.id) && 'enter',
    ].filter(Boolean).join(' ');
    const g = el('g', { class: cls, transform: `translate(${x},${y})`, 'data-id': n.id }, nodesG);
    const tip = [
      `${n.id}  ${n.message}`,
      `author: ${n.author}`,
      n.parents.length ? `parents: ${n.parents.join(', ')}` : 'root commit',
      n.copiedFrom ? `copy of ${n.copiedFrom} (rebase / cherry-pick)` : null,
      n.faded ? 'unreachable: no branch or HEAD points here' : null,
    ].filter(Boolean).join('\n');
    el('title', {}, g).textContent = tip;
    if (n.isHead) el('circle', { r: R + 5, class: 'head-ring' }, g);
    // Your commits are round; everyone else's are square. Both carry the author's initials.
    if (n.author !== me) el('rect', { x: -R, y: -R, width: R * 2, height: R * 2, rx: 4, class: 'dot' }, g);
    else el('circle', { r: R, class: 'dot' }, g);
    const ini = initials(n.author);
    text(g, ini, { y: 3.5, class: `initial${[...ini].length > 1 ? ' two' : ''}` });
    text(g, n.id.slice(0, 7), { y: R + 15, class: 'hash' });
    text(g, truncate(n.message, colW - 8), { y: R + 29, class: 'msg' });
    if (onNodeClick) g.addEventListener('click', () => onNodeClick(n));

    // Labels stacked above the node, current branch nearest to it.
    n.labels.forEach((l, i) => {
      const w = Math.round(l.text.length * CHAR_W + 16);
      const ly = y - R - 8 - (n.labels.length - i) * (LABEL_H + LABEL_GAP) + LABEL_GAP;
      const moved = prev && prev.labels.has(l.ref) && prev.labels.get(l.ref) !== n.id;
      const isNew = prev && !prev.labels.has(l.ref);
      const lg = el('g', {
        class: `label ${l.type} lane-${n.lane % LANE_COLORS}${n.faded ? ' faded' : ''}${moved || isNew ? ' flash' : ''}`,
        transform: `translate(${x - w / 2},${ly})`,
      }, labelsG);
      el('rect', { width: w, height: LABEL_H, rx: LABEL_H / 2 }, lg);
      text(lg, l.text, { x: w / 2, y: LABEL_H / 2 + 4 });
      labelMap.set(l.ref, n.id);
    });
  }
  return { nodes: seen, labels: labelMap, root, width, height };
}
