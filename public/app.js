import { World, run, GIT_COMMANDS } from './git/index.js';
import { layout } from './layout.js';
import { renderPanel, columnWidth } from './render.js';
import { LinkedPanZoom } from './pan-zoom.js';

const $ = (id) => document.getElementById(id);
const svgLocal = $('svg-local');
const svgRemote = $('svg-remote');
const viewLocal = $('view-local');
const viewRemote = $('view-remote');
const output = $('output');
const input = $('cmd');
const ps1 = $('ps1');

let world = new World();
let prev = { local: null, remote: null };
const cmdHistory = [];
let historyIdx = 0;
let draft = '';

// ---- drawing ---------------------------------------------------------------

function span(text, cls) {
  const s = document.createElement('span');
  s.textContent = text;
  if (cls) s.className = cls;
  return s;
}

function updateMeta() {
  const meta = $('local-meta');
  meta.replaceChildren();
  const cur = world.currentBranch();
  if (!cur) {
    meta.append(span('HEAD detached at '), span(world.headId(), 'behind'));
  } else {
    meta.append(span('on '), Object.assign(document.createElement('b'), { textContent: cur }));
    const up = world.local.upstream.get(cur);
    const upId = up && world.local.remoteRefs.get(up);
    if (upId) {
      const id = world.local.branches.get(cur);
      const ahead = world.range(upId, id).length;
      const behind = world.range(id, upId).length;
      meta.append(
        span(' · '),
        span(`↑${ahead}`, ahead ? 'ahead' : ''),
        span(' '),
        span(`↓${behind}`, behind ? 'behind' : ''),
        span(` vs ${up} (as of last fetch)`),
      );
    } else {
      meta.append(span(' · no upstream (push with -u to set one)'));
    }
  }
  $('remote-meta').textContent = `${world.remote.branches.size} branch${world.remote.branches.size === 1 ? '' : 'es'}`;

  ps1.replaceChildren(span('~/project '));
  ps1.append(cur ? span(`(${cur})`, 'br') : span(`(${world.headId()}…)`, 'br detached'), span(' $'));
}

function draw({ follow = true } = {}) {
  const lay = layout(world);
  const colW = columnWidth([lay.local, lay.remote]);
  const insertRef = (n) => insertAtCursor(n.id);
  prev.local = renderPanel(svgLocal, lay.local, { columns: lay.columns, colW, prev: prev.local, onNodeClick: insertRef });
  prev.remote = renderPanel(svgRemote, lay.remote, { columns: lay.columns, colW, prev: prev.remote, onNodeClick: insertRef });
  updateMeta();
  // Give each panel vertical space in proportion to how tall its graph is.
  const head = document.querySelector('.panel-head').offsetHeight + 2;
  const hl = prev.local.height + head;
  const hr = prev.remote.height + head;
  document.querySelector('.panels').style.gridTemplateRows = `minmax(0, ${hl}fr) minmax(0, ${hr}fr)`;
  camera.setContent(0, prev.local.root, prev.local.width, prev.local.height);
  camera.setContent(1, prev.remote.root, prev.remote.width, prev.remote.height);
  if (follow) camera.follow(); // keep the newest commits in view
}

// Pan / pinch / zoom. Horizontal pan and zoom are shared so commits stay aligned.
const zoomLevel = $('zoom-level');
const camera = new LinkedPanZoom([viewLocal, viewRemote], {
  onChange: (k) => (zoomLevel.textContent = `${Math.round(k * 100)}%`),
});
$('zoom-in').addEventListener('click', () => camera.zoomBy(1.25));
$('zoom-out').addEventListener('click', () => camera.zoomBy(0.8));
$('zoom-level').addEventListener('click', () => camera.reset());
$('zoom-fit').addEventListener('click', () => camera.fit());

// ---- console ---------------------------------------------------------------

function print(lines) {
  for (const l of lines) {
    const div = document.createElement('div');
    div.className = `line ${l.kind}`;
    div.textContent = l.text;
    output.appendChild(div);
  }
  output.scrollTop = output.scrollHeight;
}

function echo(cmd) {
  const div = document.createElement('div');
  div.className = 'line cmd';
  div.append(span(`${ps1.textContent} `, 'ps1-echo'), span(cmd));
  output.appendChild(div);
}

function welcome() {
  print([
    { kind: 'heading', text: 'Welcome! This is a freshly cloned repo: three commits on main, also on origin.' },
    { kind: 'note', text: 'Type git commands below. Only the graph changes: no files, no real git.' },
    { kind: 'note', text: 'Try: git checkout -b feature → git commit → git push -u origin feature' },
    { kind: 'note', text: 'Use "remote commit" (or the button above) to make a teammate push, then try pull / rebase.' },
    { kind: 'note', text: 'Type "help" for every command. ↑/↓ = history, Tab = complete, click a commit to insert its hash.' },
    { kind: 'note', text: 'Graphs: drag or two-finger scroll to pan, pinch or ⌘/Ctrl+scroll to zoom, double-click to fit.' },
  ]);
}

function execute(cmd) {
  echo(cmd);
  if (cmd.trim()) {
    if (cmdHistory[cmdHistory.length - 1] !== cmd) cmdHistory.push(cmd);
  }
  historyIdx = cmdHistory.length;
  let res;
  try {
    res = run(world, cmd);
  } catch (e) {
    console.error(e);
    res = { lines: [{ kind: 'err', text: `internal error: ${e.message}` }], ok: false };
  }
  if (res.clear) output.replaceChildren();
  print(res.lines);
  draw();
}

$('prompt').addEventListener('submit', (e) => {
  e.preventDefault();
  const cmd = input.value;
  input.value = '';
  execute(cmd);
});

function insertAtCursor(str) {
  const { selectionStart: s, selectionEnd: e, value } = input;
  const before = value.slice(0, s);
  const pad = before && !before.endsWith(' ') ? ' ' : '';
  input.value = before + pad + str + value.slice(e);
  const pos = (before + pad + str).length;
  input.focus();
  input.setSelectionRange(pos, pos);
}

function completions(value) {
  const parts = value.split(/\s+/);
  const word = parts[parts.length - 1];
  let pool;
  if (parts.length === 1) pool = ['git', 'help', 'undo', 'clear', 'remote'];
  else if (parts.length === 2 && parts[0] === 'git') pool = GIT_COMMANDS;
  else if (parts.length === 2 && parts[0] === 'remote') pool = ['commit', 'branch'];
  else {
    pool = [
      ...world.local.branches.keys(),
      ...world.local.remoteRefs.keys(),
      ...(parts[0] === 'remote' ? world.remote.branches.keys() : []),
      'origin',
      'HEAD',
    ];
  }
  return { word, matches: [...new Set(pool)].filter((c) => c.startsWith(word)).sort() };
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp') {
    if (historyIdx === cmdHistory.length) draft = input.value;
    if (historyIdx > 0) input.value = cmdHistory[--historyIdx];
    e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    if (historyIdx < cmdHistory.length) {
      historyIdx++;
      input.value = historyIdx === cmdHistory.length ? draft : cmdHistory[historyIdx];
    }
    e.preventDefault();
  } else if (e.key === 'Tab') {
    e.preventDefault();
    const { word, matches } = completions(input.value);
    if (!matches.length) return;
    let common = matches[0];
    for (const m of matches) while (!m.startsWith(common)) common = common.slice(0, -1);
    if (matches.length === 1) common += ' ';
    if (common.length > word.length || matches.length === 1) {
      input.value = input.value.slice(0, input.value.length - word.length) + common;
    } else {
      print([{ kind: 'out', text: matches.join('   ') }]);
    }
  } else if (e.key === 'l' && e.ctrlKey) {
    e.preventDefault();
    output.replaceChildren();
  }
});

// Clicking the console focuses the input (unless the user is selecting text).
document.querySelector('.terminal').addEventListener('mouseup', () => {
  if (!window.getSelection().toString()) input.focus();
});

// ---- buttons ---------------------------------------------------------------

$('btn-teammate').addEventListener('click', () => {
  execute('remote commit main');
  input.focus();
});
$('btn-undo').addEventListener('click', () => {
  execute('undo');
  input.focus();
});
$('btn-reset').addEventListener('click', () => {
  world = new World();
  prev = { local: null, remote: null };
  output.replaceChildren();
  welcome();
  camera.reset();
  draw();
  input.focus();
});

welcome();
draw();
input.focus();
