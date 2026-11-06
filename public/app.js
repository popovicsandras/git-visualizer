import { World, GIT_COMMANDS, MAIN_WORKTREE, QUICK_ACTIONS, isValidBranchName, quickAction, relativePath } from './git/index.js';
import { layout } from './layout.js';
import { renderPanel, columnWidth } from './render.js';
import { LinkedPanZoom } from './pan-zoom.js';
import { SessionClient } from './net.js';
import { initials } from './people.js';

const $ = (id) => document.getElementById(id);
const svgLocal = $('svg-local');
const svgRemote = $('svg-remote');
const viewLocal = $('view-local');
const viewRemote = $('view-remote');
const output = $('output');
const input = $('cmd');
const ps1 = $('ps1');

// The server runs every command; `world` is a read-only mirror of what it last sent
// (your repository plus the session's shared origin), used for drawing and Tab completion.
let world = null;
let me = null; // { id, name }
let sessionCode = null;
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
  if (!world) return;
  const lay = layout(world);
  const colW = columnWidth([lay.local, lay.remote]);
  const insertRef = (n) => insertAtCursor(n.id);
  const opts = { columns: lay.columns, colW, me: me.name, onNodeClick: insertRef };
  prev.local = renderPanel(svgLocal, lay.local, { ...opts, prev: prev.local });
  prev.remote = renderPanel(svgRemote, lay.remote, { ...opts, prev: prev.remote });
  updateMeta();
  renderWorktrees();
  renderQuickActions();
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

function svgIcon(d, size = 14) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
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
  execute(cmd).then((ok) => ok && execute(`cd ${folder}`));
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
    if (l.who) div.append(span(l.who, 'who'), ' ');
    div.append(l.text);
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

function printWelcome({ created, resumed }) {
  const tips = [
    { kind: 'note', text: 'Type git commands below. Only the graphs change: no files, no real git.' },
    { kind: 'note', text: 'Try: git checkout -b feature → git commit → git push -u origin feature' },
    {
      kind: 'note',
      text: "When anyone pushes, the REMOTE panel changes for everyone at once. Your origin/* labels only move when you git fetch or git pull, like in real git.",
    },
    { kind: 'note', text: "Round commits are yours; square ones are a teammate's (hover for the author)." },
    { kind: 'note', text: 'Worktrees (left sidebar) give a branch its own folder: try "+ New worktree", then click a card (or cd) to switch.' },
    { kind: 'note', text: 'Type "help" for every command. ↑/↓ = history, Tab = complete, click a commit to insert its hash.' },
    { kind: 'note', text: 'Graphs: drag or two-finger scroll to pan, pinch or ⌘/Ctrl+scroll to zoom, double-click to fit.' },
  ];
  if (resumed) {
    print([{ kind: 'heading', text: `Welcome back, ${me.name}. Your repository is as you left it.` }, tips[2], tips[5]]);
  } else if (created) {
    print([
      { kind: 'heading', text: `You started session ${sessionCode}: a fresh repo with three commits on main, also on origin.` },
      { kind: 'note', text: 'Invite teammates with the session button at the top. Each of them gets their own clone of this origin.' },
      ...tips,
    ]);
  } else {
    print([{ kind: 'heading', text: `You joined session ${sessionCode} as ${me.name}. This is your own fresh clone of its origin.` }, ...tips]);
  }
}

// Commands run one at a time, in order: echo, wait for the server, print. Activity
// from teammates that arrives meanwhile waits until the output is printed.
let queue = Promise.resolve();
let busy = false;
let deferred = [];

/** Run a command line on the server. Resolves to whether it succeeded. */
function execute(cmd, { record = true } = {}) {
  const job = queue.then(() => runCommand(cmd, record));
  queue = job.catch(() => {});
  return job;
}

async function runCommand(cmd, record) {
  echo(cmd);
  if (record && cmd.trim() && cmdHistory[cmdHistory.length - 1] !== cmd) cmdHistory.push(cmd);
  historyIdx = cmdHistory.length;
  if (!cmd.trim()) return true;
  return request(() => client.command(cmd));
}

async function request(send) {
  busy = true;
  document.body.classList.add('busy');
  try {
    const res = await send();
    if (res.clear) output.replaceChildren();
    print(res.lines);
    applyState(res.state);
    return res.ok;
  } catch (e) {
    print([{ kind: 'err', text: e.message }]);
    return false;
  } finally {
    busy = false;
    document.body.classList.remove('busy');
    const later = deferred;
    deferred = [];
    for (const f of later) f();
  }
}

function applyState(state, { follow = true } = {}) {
  world = World.fromView(state, { author: me.name, shared: true });
  draw({ follow });
}

let explainedFetch = false;
function showActivity({ who, items }) {
  const lines = items.map((text) => ({ kind: 'activity', who, text }));
  if (!explainedFetch && items.some((t) => / origin/.test(t))) {
    explainedFetch = true;
    lines.push({
      kind: 'note',
      text: 'The REMOTE panel already shows it. Your origin/* branches catch up when you run "git fetch" (or "git pull").',
    });
  }
  if (busy) deferred.push(() => print(lines));
  else print(lines);
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
  if (!world) return { word, matches: [] };
  if (parts.length === 1) pool = ['git', 'help', 'undo', 'clear', 'cd', 'pwd'];
  else if (parts.length === 2 && parts[0] === 'cd') pool = [...otherFolders(), '-'];
  else if (parts.length === 2 && parts[0] === 'git') pool = GIT_COMMANDS;
  else if (parts.length === 3 && parts[1] === 'worktree') pool = ['add', 'list', 'remove'];
  else if (parts[1] === 'worktree' && parts[2] === 'remove') {
    pool = world.otherWorktrees().filter((t) => t.path !== MAIN_WORKTREE).map((t) => relativePath(t.path, world.cwd));
  }
  else {
    pool = [...world.local.branches.keys(), ...world.local.remoteRefs.keys(), 'origin', 'HEAD'];
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

$('btn-undo').addEventListener('click', () => {
  execute('undo');
  input.focus();
});
$('btn-reset').addEventListener('click', () => {
  // Re-clone: replace your repository with a fresh clone of origin (undo brings it back).
  const job = queue.then(() => request(() => client.reclone()));
  queue = job.catch(() => {});
  input.focus();
});
$('btn-leave').addEventListener('click', () => {
  const code = sessionCode;
  client.leave();
  forgetToken(code); // don't jump straight back in on reload
  showLobby({ code });
});

// ---- quick actions (right rail) ------------------------------------------------
// One click runs the default git command for the current branch, echoed in the terminal
// like a typed one. quickAction() decides the exact command from the current state.

const QUICK = {
  commit: { label: 'Commit', group: 'local', icon: 'M1.5 8H5M11 8h3.5M5 8a3 3 0 1 0 6 0a3 3 0 1 0-6 0' },
  rebase: { label: 'Rebase', group: 'local', icon: 'M4 2v12M4 12c4 0 8-1.5 8-6V3M10 5l2-2 2 2' },
  fetch: {
    label: 'Fetch',
    group: 'remote',
    icon: 'M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.49 1.83L14 5.33M14 2v3.33h-3.33',
  },
  pull: { label: 'Pull', group: 'remote', icon: 'M8 11.3V2M4 7.3l4 4 4-4M12.7 14H3.3' },
  push: { label: 'Push', group: 'remote', icon: 'M12 6 8 2 4 6M8 2v9.3M3.3 14h9.4' },
  'force-push': {
    label: 'Force push',
    group: 'remote',
    danger: true,
    icon: 'M12 6.5 8 2.5 4 6.5M12 10.5 8 6.5 4 10.5M3.3 14h9.4',
  },
};
const qaList = $('qa-list');
const qaTip = $('qa-tip');
const qaButtons = new Map(); // kind -> { btn, desc }
let tipFor = null; // the button whose tooltip is showing

function runQuickAction(kind) {
  const job = queue.then(() => {
    // Decide when it runs, not on click: a queued command (a cd, another click) may move HEAD first.
    const a = world && quickAction(world, kind);
    if (!a) return false;
    if (!a.cmd) {
      print([{ kind: 'err', text: a.reason }]);
      return false;
    }
    return runCommand(a.cmd, true);
  });
  queue = job.catch(() => {});
}

function fillTip(btn) {
  const kind = btn.dataset.kind;
  const a = world ? quickAction(world, kind) : { cmd: null, reason: '' };
  qaTip.querySelector('.qa-tip-title').textContent = QUICK[kind].label;
  qaTip.querySelector('.qa-tip-text').textContent = a.cmd ? a.detail : a.reason;
  qaTip.querySelector('.qa-tip-cmd').textContent = a.cmd ?? '';
  qaTip.classList.toggle('danger', Boolean(QUICK[kind].danger && a.cmd));
  qaTip.classList.toggle('unavailable', !a.cmd);
  // To the left of the button, kept on screen; the arrow keeps pointing at the button.
  const r = btn.getBoundingClientRect();
  const { width, height } = qaTip.getBoundingClientRect();
  const y = Math.max(8, Math.min(window.innerHeight - height - 8, r.top + r.height / 2 - height / 2));
  qaTip.style.left = `${Math.max(8, r.left - 10 - width)}px`;
  qaTip.style.top = `${y}px`;
  qaTip.style.setProperty('--arrow-y', `${r.top + r.height / 2 - y}px`);
}
function showTip(btn) {
  tipFor = btn;
  fillTip(btn);
  qaTip.classList.add('show');
}
function hideTip() {
  tipFor = null;
  qaTip.classList.remove('show');
}

let lastGroup = null;
for (const kind of QUICK_ACTIONS) {
  const { label, group, icon, danger } = QUICK[kind];
  if (lastGroup && group !== lastGroup) {
    qaList.append(Object.assign(document.createElement('div'), { className: 'qa-sep', role: 'separator' }));
  }
  lastGroup = group;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `qa-btn${danger ? ' danger' : ''}`;
  btn.dataset.kind = kind;
  btn.setAttribute('aria-label', label);
  const desc = span('', 'sr-only');
  desc.id = `qa-desc-${kind}`;
  btn.setAttribute('aria-describedby', desc.id);
  btn.append(svgIcon(icon, 16), desc);
  btn.addEventListener('click', (e) => {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    runQuickAction(kind);
    if (e.detail !== 0) input.focus(); // a mouse click; keyboard users stay on the button
  });
  btn.addEventListener('pointerenter', (e) => e.pointerType !== 'touch' && showTip(btn));
  btn.addEventListener('pointerleave', () => tipFor === btn && !btn.matches(':focus-visible') && hideTip());
  btn.addEventListener('focus', () => btn.matches(':focus-visible') && showTip(btn));
  btn.addEventListener('blur', () => tipFor === btn && !btn.matches(':hover') && hideTip());
  qaList.append(btn);
  qaButtons.set(kind, { btn, desc });
}
document.addEventListener('keydown', (e) => e.key === 'Escape' && hideTip());
window.addEventListener('resize', hideTip);

/** Enable/disable each button and refresh its description (and the open tooltip) for the current state. */
function renderQuickActions() {
  for (const [kind, { btn, desc }] of qaButtons) {
    const a = quickAction(world, kind);
    btn.setAttribute('aria-disabled', String(!a.cmd));
    desc.textContent = a.cmd ? `${a.detail} Runs ${a.cmd}` : a.reason;
  }
  if (tipFor) fillTip(tipFor);
}

// ---- people + invite ---------------------------------------------------------

function renderPeople(list) {
  const rank = (p) => (p.id === me.id ? 0 : p.online ? 1 : 2);
  const sorted = [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  $('people').replaceChildren(
    ...sorted.map((p) => {
      const li = document.createElement('li');
      const you = p.id === me.id;
      li.className = `person${p.online ? ' online' : ''}${you ? ' me' : ''}`;
      li.title = `${p.name}${you ? ' (you)' : ''}: ${p.online ? 'online' : 'offline'}`;
      li.setAttribute('aria-label', li.title);
      li.append(span(initials(p.name), 'avatar'));
      return li;
    }),
  );
}

const inviteDialog = $('invite-dialog');
const inviteCopy = $('invite-copy');
const isLoopback = (host) => ['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.localhost');

function openInvite({ created = false } = {}) {
  $('invite-title').textContent = created ? 'Your session is ready' : 'Invite people';
  $('invite-link').value = linkFor(sessionCode);
  $('invite-code').textContent = sessionCode;
  $('invite-host').textContent = location.host;
  $('invite-local').hidden = !isLoopback(location.hostname);
  inviteCopy.textContent = 'Copy link';
  inviteDialog.showModal();
  inviteCopy.focus();
}

inviteCopy.addEventListener('click', async () => {
  const field = $('invite-link');
  let copied = false;
  try {
    await navigator.clipboard.writeText(field.value);
    copied = true;
  } catch {
    // The async clipboard needs a secure context (https or localhost); fall back to selecting.
    field.focus();
    field.select();
    try {
      copied = document.execCommand('copy');
    } catch {}
  }
  inviteCopy.textContent = copied ? 'Copied!' : 'Press Ctrl/⌘+C';
  setTimeout(() => (inviteCopy.textContent = 'Copy link'), 1800);
});
$('invite-link').addEventListener('focus', (e) => e.target.select());
$('btn-invite').addEventListener('click', () => openInvite());
closeOnBackdrop(inviteDialog);

// ---- session lifecycle -------------------------------------------------------

const client = new SessionClient({
  onState: (state) => world && applyState(state),
  onPeople: (list) => me && renderPeople(list),
  onActivity: (msg) => me && showActivity(msg),
  onStatus(status, welcome) {
    $('conn-banner').hidden = status !== 'reconnecting';
    if (status === 'online' && welcome) {
      enterSession(welcome, { reconnect: true });
      print([{ kind: 'note', text: 'Reconnected.' }]);
    }
  },
  onLost(err) {
    const code = sessionCode;
    forgetToken(code);
    showLobby({ code, error: err.message });
  },
});

const NAME_KEY = 'git-visualizer:name';
// Per tab (sessionStorage): a reload rejoins as you, while a second tab can join as someone else.
const tokenKey = (code) => `git-visualizer:token:${code}`;
function readToken(code) {
  try {
    return JSON.parse(sessionStorage.getItem(tokenKey(code)) ?? 'null');
  } catch {
    return null;
  }
}
function saveToken(code, value) {
  try {
    sessionStorage.setItem(tokenKey(code), JSON.stringify(value));
  } catch {}
}
function forgetToken(code) {
  try {
    if (code) sessionStorage.removeItem(tokenKey(code));
  } catch {}
}

const linkFor = (code) => `${location.origin}/?session=${code}`;

/** The session code in a pasted link or typed code, or null. */
function parseCode(text) {
  let candidate = text.trim();
  try {
    candidate = new URL(candidate).searchParams.get('session') ?? '';
  } catch {}
  const bare = candidate.toLowerCase().replace(/[\s-]/g, '');
  return /^[a-z0-9]{12}$/.test(bare) ? `${bare.slice(0, 4)}-${bare.slice(4, 8)}-${bare.slice(8)}` : null;
}

function enterSession(w, { reconnect = false } = {}) {
  me = w.you;
  sessionCode = w.session;
  saveToken(sessionCode, { token: w.token, name: me.name });
  if (new URLSearchParams(location.search).get('session') !== sessionCode) {
    history.replaceState(null, '', `?session=${sessionCode}`);
  }
  document.title = `${me.name} · ${sessionCode} · Git Visualizer`;
  $('session-code').textContent = sessionCode;
  document.body.classList.remove('in-lobby');
  if (!reconnect) {
    output.replaceChildren();
    prev = { local: null, remote: null };
    explainedFetch = false;
    camera.reset();
  }
  renderPeople(w.people);
  applyState(w.state);
  if (reconnect) return;
  printWelcome(w);
  if (w.created) openInvite({ created: true });
  else input.focus();
}

// ---- lobby -------------------------------------------------------------------

const lobbyName = $('lobby-name');
const lobbyLink = $('lobby-link');
const lobbyError = $('lobby-error');
const btnCreate = $('btn-create');
const btnJoin = $('btn-join');

function showLobby({ code = null, error = '' } = {}) {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  hideTip();
  document.body.classList.add('in-lobby');
  document.title = 'Git Visualizer';
  world = null;
  me = null;
  sessionCode = null;
  output.replaceChildren();
  $('conn-banner').hidden = true;
  if (code) lobbyLink.value = linkFor(code);
  lobbyError.textContent = error;
  for (const f of [lobbyName, lobbyLink]) f.removeAttribute('aria-invalid');
  updateLobbyEmphasis();
  (lobbyName.value && lobbyLink.value ? btnJoin : lobbyName).focus();
}

/** With a link filled in, joining is the likely next step: make it the primary action. */
function updateLobbyEmphasis() {
  const joining = lobbyLink.value.trim() !== '';
  $('choice-join').classList.toggle('suggested', joining);
  btnJoin.classList.toggle('primary', joining);
  btnCreate.classList.toggle('primary', !joining);
}
lobbyLink.addEventListener('input', updateLobbyEmphasis);

function lobbyFail(message, field = null) {
  lobbyError.textContent = message;
  for (const f of [lobbyName, lobbyLink]) f.setAttribute('aria-invalid', String(f === field));
  field?.focus();
}

let entering = false;
async function enterFromLobby(action) {
  if (entering) return;
  const name = lobbyName.value.replace(/\s+/g, ' ').trim();
  if (!name) return lobbyFail('Enter your name first.', lobbyName);
  let code = null;
  if (action === 'join') {
    if (!lobbyLink.value.trim()) return lobbyFail('Paste the session link or code you were sent.', lobbyLink);
    code = parseCode(lobbyLink.value);
    if (!code) return lobbyFail("That doesn't look like a session link or code.", lobbyLink);
  }
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {}
  entering = true;
  document.body.classList.add('entering');
  lobbyFail('');
  try {
    let w;
    if (action === 'create') {
      w = await client.create(name);
    } else {
      const saved = readToken(code);
      const token = saved && saved.name.toLowerCase() === name.toLowerCase() ? saved.token : undefined;
      w = await client.join(code, { name, token });
    }
    enterSession(w);
  } catch (e) {
    let msg = e.message;
    if (e.code === 'not_found') {
      // A link copied from another address of this server won't help; say where it points.
      try {
        const origin = new URL(lobbyLink.value.trim()).origin;
        if (origin !== location.origin) msg += ` (That link is for ${origin}; try opening it directly.)`;
      } catch {}
    }
    lobbyFail(msg, ['invalid_name', 'name_taken'].includes(e.code) ? lobbyName : action === 'join' ? lobbyLink : null);
  } finally {
    entering = false;
    document.body.classList.remove('entering');
  }
}

btnCreate.addEventListener('click', () => enterFromLobby('create'));
btnJoin.addEventListener('click', () => enterFromLobby('join'));
lobbyName.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  enterFromLobby(lobbyLink.value.trim() ? 'join' : 'create');
});
lobbyLink.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  enterFromLobby('join');
});
$('lobby-form').addEventListener('submit', (e) => e.preventDefault());

// ---- start -------------------------------------------------------------------

{
  try {
    lobbyName.value = localStorage.getItem(NAME_KEY) ?? '';
  } catch {}
  const code = parseCode(new URLSearchParams(location.search).get('session') ?? '');
  const saved = code && readToken(code);
  if (saved) {
    // A reload: go straight back into the session as yourself.
    showLobby({ code });
    client
      .join(code, { token: saved.token })
      .then((w) => enterSession(w))
      .catch((e) => {
        forgetToken(code);
        showLobby({ code, error: e.message });
      });
  } else {
    showLobby({ code });
  }
}
