import { World, run, GIT_COMMANDS, MAIN_WORKTREE, isValidBranchName, relativePath } from './git/index.js';
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
  if (world.cwd !== MAIN_WORKTREE) meta.append(span(world.cwd, 'cwd'), span(' · '));
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

  ps1.replaceChildren(span(`${world.cwd} `));
  ps1.append(cur ? span(`(${cur})`, 'br') : span(`(${world.headId()}…)`, 'br detached'), span(' $'));
}

function draw({ follow = true } = {}) {
  const lay = layout(world);
  const colW = columnWidth([lay.local, lay.remote]);
  const insertRef = (n) => insertAtCursor(n.id);
  prev.local = renderPanel(svgLocal, lay.local, { columns: lay.columns, colW, prev: prev.local, onNodeClick: insertRef });
  prev.remote = renderPanel(svgRemote, lay.remote, { columns: lay.columns, colW, prev: prev.remote, onNodeClick: insertRef });
  updateMeta();
  renderWorktrees();
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

// ---- worktree sidebar ------------------------------------------------------

const sidebar = $('sidebar');
const sidebarToggle = $('sidebar-toggle');
const wtList = $('wt-list');
const SIDEBAR_KEY = 'git-visualizer:sidebar-collapsed';
let shownWorktrees = null; // paths rendered last time, to animate new ones
let shownCwd = null; // the folder the prompt was in last time, to animate a switch

function setSidebarCollapsed(collapsed, { save = true } = {}) {
  sidebar.classList.toggle('collapsed', collapsed);
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  sidebarToggle.title = collapsed ? 'Expand worktrees' : 'Collapse worktrees';
  sidebarToggle.setAttribute('aria-label', sidebarToggle.title);
  if (save) {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    } catch {}
  }
}
{
  let stored = null;
  try {
    stored = localStorage.getItem(SIDEBAR_KEY);
  } catch {}
  setSidebarCollapsed(stored === null ? window.innerWidth < 700 : stored === '1', { save: false });
}
sidebarToggle.addEventListener('click', () => setSidebarCollapsed(!sidebar.classList.contains('collapsed')));

// Resize by dragging the right border (or with the arrow keys when the handle has focus).
const resizer = $('sidebar-resizer');
const SIDEBAR_WIDTH_KEY = 'git-visualizer:sidebar-width';
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 520;
const SNAP_COLLAPSE = 110; // dragging narrower than this collapses the sidebar
const sidebarMax = () => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(window.innerWidth * 0.5)));
const defaultSidebarWidth = () => {
  sidebar.style.removeProperty('--sidebar-w');
  return parseFloat(getComputedStyle(sidebar).getPropertyValue('--sidebar-w'));
};
let sidebarPreferred = null; // what the user chose; the window may force it narrower for now

/** Apply the preferred width, narrowed to fit the current window. */
function applySidebarWidth() {
  const w = Math.round(Math.min(sidebarMax(), Math.max(SIDEBAR_MIN, sidebarPreferred ?? defaultSidebarWidth())));
  sidebar.style.setProperty('--sidebar-w', `${w}px`);
  resizer.setAttribute('aria-valuemin', SIDEBAR_MIN);
  resizer.setAttribute('aria-valuemax', sidebarMax());
  resizer.setAttribute('aria-valuenow', w);
  return w;
}
function setSidebarWidth(px, { save = true } = {}) {
  sidebarPreferred = Math.round(Math.min(sidebarMax(), Math.max(SIDEBAR_MIN, px)));
  applySidebarWidth();
  if (save) {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarPreferred));
    } catch {}
  }
}
const sidebarWidth = () => Number(resizer.getAttribute('aria-valuenow'));
try {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (stored > 0) sidebarPreferred = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, stored));
} catch {}
applySidebarWidth();
window.addEventListener('resize', applySidebarWidth);

resizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startW = sidebar.getBoundingClientRect().width;
  sidebar.classList.add('resizing');
  document.body.classList.add('resizing-sidebar');
  let moved = false;
  const move = (ev) => {
    moved = true;
    const w = startW + ev.clientX - startX;
    const collapsed = sidebar.classList.contains('collapsed');
    if (w < SNAP_COLLAPSE) {
      if (!collapsed) setSidebarCollapsed(true);
    } else {
      if (collapsed) setSidebarCollapsed(false);
      setSidebarWidth(w, { save: false });
    }
  };
  const end = () => {
    resizer.removeEventListener('pointermove', move);
    resizer.removeEventListener('lostpointercapture', end);
    sidebar.classList.remove('resizing');
    document.body.classList.remove('resizing-sidebar');
    if (moved) setSidebarWidth(sidebarWidth());
  };
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('lostpointercapture', end);
});
resizer.addEventListener('dblclick', () => {
  sidebarPreferred = null;
  try {
    localStorage.removeItem(SIDEBAR_WIDTH_KEY);
  } catch {}
  applySidebarWidth();
  setSidebarCollapsed(false);
});
resizer.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 64 : 16;
  const next = { ArrowLeft: sidebarWidth() - step, ArrowRight: sidebarWidth() + step, Home: SIDEBAR_MIN, End: sidebarMax() }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  if (sidebar.classList.contains('collapsed')) setSidebarCollapsed(false);
  setSidebarWidth(next);
});

function svgIcon(d) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}
const TRASH = 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4';

function renderWorktrees() {
  const all = world.worktreeList();
  $('wt-count').textContent = all.length;
  const arrived = shownCwd !== null && shownCwd !== world.cwd;
  const items = all.map((t) => {
    const li = document.createElement('li');
    const isNew = shownWorktrees && !shownWorktrees.has(t.path);
    li.className = `wt-item${t.main ? ' main' : ''}${t.current ? ' current' : ''}${isNew ? ' enter' : ''}`;
    if (t.current && arrived && !isNew) li.classList.add('arrive');
    const top = document.createElement('div');
    top.className = 'wt-top';
    // The folder name is the switch button; its ::after stretches over the whole card.
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'wt-open';
    open.textContent = t.path;
    if (t.current) {
      open.setAttribute('aria-current', 'true');
      open.title = `${t.path}: the terminal is in this worktree`;
      open.addEventListener('click', () => input.focus());
    } else {
      open.title = `Switch to ${t.path}  (cd ${relativePath(t.path, world.cwd)})`;
      open.addEventListener('click', () => {
        execute(`cd ${relativePath(t.path, world.cwd)}`);
        input.focus();
      });
    }
    top.append(open);
    if (t.current) top.append(Object.assign(span('prompt', 'wt-tag'), { title: 'The terminal below runs in this worktree.' }));
    if (t.main) {
      // PROMPT plus the highlight already mark it when you're in it; keep the path room at narrow widths.
      if (!t.current) top.append(Object.assign(span('main', 'wt-tag muted'), { title: 'The main worktree (where the repo was cloned). It cannot be deleted.' }));
    } else {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'wt-del';
      del.title = t.current ? `You're in ${t.path}. Switch to another worktree to delete it.` : `Delete worktree ${t.path}`;
      del.setAttribute('aria-label', t.current ? `Delete worktree ${t.path} (unavailable while you're in it)` : del.title);
      del.disabled = t.current;
      del.append(svgIcon(TRASH));
      del.addEventListener('click', () => confirmDelete(t));
      top.append(del);
    }
    li.append(top);
    const ref = document.createElement('div');
    ref.className = 'wt-ref';
    const id = world.worktreeHeadId(t);
    if (t.head.type === 'branch') ref.append(Object.assign(span(t.head.name, 'br'), { title: t.head.name }));
    else ref.append(span('detached HEAD', 'br detached'));
    ref.append(span(id.slice(0, 7), 'hash'));
    li.append(ref);
    return li;
  });
  wtList.replaceChildren(...items);
  shownWorktrees = new Set(all.map((t) => t.path));
  shownCwd = world.cwd;
}

/** Make a dialog close when its backdrop (and only its backdrop) is clicked. */
function closeOnBackdrop(dialog) {
  let downOnBackdrop = false;
  dialog.addEventListener('pointerdown', (e) => (downOnBackdrop = e.target === dialog));
  dialog.addEventListener('click', (e) => {
    if (downOnBackdrop && e.target === dialog) dialog.close();
    downOnBackdrop = false;
  });
  dialog.addEventListener('close', () => input.focus());
  for (const b of dialog.querySelectorAll('[data-close]')) b.addEventListener('click', () => dialog.close());
}

// New-worktree dialog: git worktree add -b <name> ../<folder> <branch>
const wtDialog = $('wt-dialog');
const wtForm = $('wt-form');
const wtBase = $('wt-base');
const wtName = $('wt-name');
const wtFolder = $('wt-folder');
const wtError = $('wt-error');
let folderEdited = false;
let showErrors = false;

const suggestFolder = (name) => (name.trim() ? `project-${name.trim().replace(/[\/\s]+/g, '-')}` : '');
const createCommand = () =>
  `git worktree add -b ${wtName.value.trim() || '<name>'} ../${wtFolder.value.trim() || '<folder>'} ${wtBase.value}`;

/** Returns [field, message] for the first problem, or null when the form is valid. */
function validateWorktree() {
  const name = wtName.value.trim();
  const folder = wtFolder.value.trim();
  if (!name) return [wtName, 'Enter a worktree name.'];
  if (!isValidBranchName(name)) return [wtName, `'${name}' is not a valid branch name.`];
  if (world.local.branches.has(name)) return [wtName, `A branch named '${name}' already exists.`];
  if (!folder) return [wtFolder, 'Enter a folder name.'];
  if (!/^[A-Za-z0-9._-]+$/.test(folder) || /^\.+$/.test(folder)) {
    return [wtFolder, 'Folder names can use letters, digits, ".", "_" and "-".'];
  }
  const path = `~/${folder}`;
  if (world.local.worktrees.has(path)) return [wtFolder, `${path} already exists.`];
  return null;
}

function refreshWorktreeForm() {
  $('wt-preview').textContent = createCommand();
  const problem = showErrors ? validateWorktree() : null;
  for (const f of [wtName, wtFolder]) f.setAttribute('aria-invalid', String(problem?.[0] === f));
  wtError.textContent = problem ? problem[1] : '';
}

function openCreateWorktree() {
  const branches = [...world.local.branches.keys()].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
  wtBase.replaceChildren(...branches.map((b) => Object.assign(document.createElement('option'), { value: b, textContent: b })));
  wtBase.value = branches.includes('main') ? 'main' : (world.currentBranch() ?? branches[0]);
  wtName.value = '';
  wtFolder.value = '';
  folderEdited = false;
  showErrors = false;
  refreshWorktreeForm();
  wtDialog.showModal();
  wtName.focus();
}

wtName.addEventListener('input', () => {
  if (!folderEdited) wtFolder.value = suggestFolder(wtName.value);
  refreshWorktreeForm();
});
wtFolder.addEventListener('input', () => {
  folderEdited = wtFolder.value !== '';
  refreshWorktreeForm();
});
wtBase.addEventListener('change', refreshWorktreeForm);
wtForm.addEventListener('submit', (e) => {
  e.preventDefault();
  showErrors = true;
  const problem = validateWorktree();
  refreshWorktreeForm();
  if (problem) return problem[0].focus();
  const cmd = createCommand();
  const folder = `../${wtFolder.value.trim()}`;
  wtDialog.close();
  // Then step into the new folder, as you would after creating it.
  if (execute(cmd)) execute(`cd ${folder}`);
});
$('wt-new').addEventListener('click', openCreateWorktree);
closeOnBackdrop(wtDialog);

// Delete confirmation: git worktree remove <path>
const wtConfirm = $('wt-confirm');
let pendingDelete = null;

function confirmDelete(t) {
  pendingDelete = t.path;
  const b = (str) => Object.assign(document.createElement('b'), { textContent: str });
  const msg = $('wt-confirm-text');
  msg.replaceChildren('This deletes the folder ', b(t.path), '. ');
  if (t.head.type === 'branch') msg.append('Branch ', b(t.head.name), ' and its commits stay in the repository.');
  else msg.append('Commits only reachable from its detached HEAD will become unreachable.');
  $('wt-confirm-cmd').textContent = `git worktree remove ${relativePath(t.path, world.cwd)}`;
  wtConfirm.showModal();
}
wtConfirm.querySelector('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const path = pendingDelete;
  pendingDelete = null;
  wtConfirm.close();
  if (path) execute(`git worktree remove ${relativePath(path, world.cwd)}`);
});
closeOnBackdrop(wtConfirm);

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
    { kind: 'note', text: 'Worktrees (left sidebar) give a branch its own folder: try "+ New worktree", then click a card (or cd) to switch.' },
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
  return res.ok;
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
  const otherFolders = () => world.otherWorktrees().map((t) => relativePath(t.path, world.cwd));
  if (parts.length === 1) pool = ['git', 'help', 'undo', 'clear', 'remote', 'cd', 'pwd'];
  else if (parts.length === 2 && parts[0] === 'cd') pool = [...otherFolders(), '-'];
  else if (parts.length === 2 && parts[0] === 'git') pool = GIT_COMMANDS;
  else if (parts.length === 2 && parts[0] === 'remote') pool = ['commit', 'branch'];
  else if (parts.length === 3 && parts[1] === 'worktree') pool = ['add', 'list', 'remove'];
  else if (parts[1] === 'worktree' && parts[2] === 'remove') {
    pool = world.otherWorktrees().filter((t) => t.path !== MAIN_WORKTREE).map((t) => relativePath(t.path, world.cwd));
  }
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
