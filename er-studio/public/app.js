/* ER Studio - frontend
   Single-origin UI over the local ER Studio server:
   - /api/fs      workspace file system
   - /api/run     vite + simulator session control
   - /api/sim     proxy to simulator automation control plane
   - /ws          status, process logs, terminal
*/

'use strict';

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const state = {
  workspace: null,
  project: null,
  running: false,
  viteUrl: null,
  startedAt: null,
  simStartedAt: null,
  firstRenderAt: null,
  hasPty: false,
  activeFile: null,
  consoleSinceId: 0,
  errCount: 0,
  warnCount: 0,
  procLogCount: 0
};

/* ---------------- toasts ---------------- */

function toast(msg, isError) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  $('#toast-host').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

function postJson(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
}

/* ---------------- websocket ---------------- */

let ws = null;
let term = null;
let fitAddon = null;

function connectWs() {
  ws = new WebSocket(`ws://${location.host}/ws`);

  ws.onopen = () => {
    $('#status-conn').textContent = 'WS CONNECTED';
    $('#status-conn').dataset.state = 'on';
  };

  ws.onclose = () => {
    $('#status-conn').textContent = 'WS DISCONNECTED';
    $('#status-conn').dataset.state = 'off';
    setTimeout(connectWs, 1500);
  };

  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'hello':
        state.workspace = msg.workspace;
        state.hasPty = msg.hasPty;
        $('#status-workspace').textContent = 'workspace: ' + msg.workspace;
        applyStatus(msg.state);
        break;
      case 'status':
        applyStatus(msg.state);
        break;
      case 'proclog':
        appendProcLog(msg.source, msg.line, msg.ts);
        break;
      case 'fs-changed':
        clearTimeout(state._treeTimer);
        state._treeTimer = setTimeout(() => {
          loadTree().catch(() => {});
          loadProjects().catch(() => {});
        }, 250);
        break;
      case 'job-done':
        if (msg.kind === 'scaffold' && msg.code === 0) {
          toast(`Project "${msg.project}" created`);
          expandedDirs.add(msg.project);
          loadTree().catch(() => {});
          loadProjects().then(() => {
            $('#project-select').value = msg.project;
            onProjectChange();
          });
        } else if (msg.kind === 'pack') {
          toast(msg.code === 0 ? 'Pack completed - .ehpk written to project directory' : 'Pack failed - see PROCESS LOG', msg.code !== 0);
        } else if (msg.code !== 0) {
          toast('Job failed - see PROCESS LOG', true);
        }
        break;
      case 'term-mode':
        if (term && msg.mode === 'exec') {
          term.writeln('\x1b[33m' + msg.note + '\x1b[0m');
        }
        break;
      case 'term-data':
        if (term) term.write(msg.data);
        break;
      case 'term-exit':
        if (term) term.writeln(`\r\n\x1b[31m[shell exited ${msg.code}]\x1b[0m`);
        break;
    }
  };
}

/* ---------------- session status ---------------- */

function applyStatus(s) {
  const wasRunning = state.running;
  state.running = s.running;
  state.viteUrl = s.viteUrl;
  state.startedAt = s.startedAt;
  state.simStartedAt = s.simStartedAt;
  if (s.project) {
    state.project = s.project;
    if ($('#project-select').value !== s.project) $('#project-select').value = s.project;
  }

  $('#btn-run').disabled = s.running;
  $('#btn-stop').disabled = !s.running;
  $('#btn-restart').disabled = !s.running;
  $('#btn-pack').disabled = !!s.job;

  const pv = $('#pill-vite');
  pv.dataset.state = s.viteAlive ? 'on' : 'off';
  pv.querySelector('b').textContent = s.vitePort ? ':' + s.vitePort : (s.running ? '…' : '—');

  const ps = $('#pill-sim');
  ps.dataset.state = s.simAlive ? 'on' : 'off';
  ps.querySelector('b').textContent = s.simAlive ? ':' + s.simAutomationPort : '—';

  // webview iframe
  const wrap = $('#webview-wrap');
  const frame = $('#webview');
  if (s.viteUrl) {
    if (frame.src !== s.viteUrl) frame.src = s.viteUrl;
    $('#btn-webview-open').href = s.viteUrl;
    wrap.classList.add('live');
  } else {
    frame.src = 'about:blank';
    wrap.classList.remove('live');
  }

  if (!wasRunning && s.running) {
    state.firstRenderAt = null;
    state.consoleSinceId = 0;
    state.errCount = 0;
    state.warnCount = 0;
    updateBadges();
    $('#m-boot').textContent = '—';
  }
  if (wasRunning && !s.running) {
    $('#lens').classList.remove('live');
  }
}

/* ---------------- projects ---------------- */

async function loadProjects() {
  const data = await api('/api/fs/projects');
  const sel = $('#project-select');
  const prev = sel.value;
  sel.innerHTML = '';
  if (data.projects.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no projects - create one)';
    sel.appendChild(opt);
  }
  for (const p of data.projects) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name + (p.hasManifest ? '' : '  [no app.json]');
    sel.appendChild(opt);
  }
  if (prev && data.projects.some(p => p.name === prev)) sel.value = prev;
  state.project = sel.value || null;
}

function onProjectChange() {
  state.project = $('#project-select').value || null;
}

/* ---------------- file tree ---------------- */

const expandedDirs = new Set();

async function loadTree() {
  const data = await api('/api/fs/tree');
  const host = $('#file-tree');
  host.innerHTML = '';
  host.appendChild(renderNodes(data.tree));
}

function renderNodes(nodes) {
  const frag = document.createDocumentFragment();
  for (const n of nodes) frag.appendChild(renderNode(n));
  return frag;
}

function renderNode(node) {
  const el = document.createElement('div');
  const expanded = node.type === 'dir' && expandedDirs.has(node.path);
  el.className = 'tree-node' + (node.type === 'dir' && !expanded ? ' collapsed' : '');
  const row = document.createElement('div');
  row.className = 'tree-row' + (node.type === 'dir' ? ' is-dir' : '') +
    (node.path === state.activeFile ? ' active' : '');
  row.dataset.path = node.path;
  row.dataset.type = node.type;

  const glyph = document.createElement('span');
  glyph.className = 'tree-glyph';
  glyph.textContent = node.type === 'dir' ? (expanded ? '▾' : '▸') : '·';
  const name = document.createElement('span');
  name.textContent = node.name;
  row.append(glyph, name);
  el.appendChild(row);

  if (node.type === 'dir') {
    const kids = document.createElement('div');
    kids.className = 'tree-children';
    kids.appendChild(renderNodes(node.children || []));
    el.appendChild(kids);
    row.addEventListener('click', () => {
      const nowCollapsed = el.classList.toggle('collapsed');
      glyph.textContent = nowCollapsed ? '▸' : '▾';
      if (nowCollapsed) expandedDirs.delete(node.path);
      else expandedDirs.add(node.path);
    });
  } else {
    row.addEventListener('click', () => openFile(node.path));
  }

  row.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    showCtxMenu(ev.clientX, ev.clientY, node);
  });

  return el;
}

// Right-click on empty explorer space: create at workspace root
$('#file-tree').addEventListener('contextmenu', ev => {
  ev.preventDefault();
  showCtxMenu(ev.clientX, ev.clientY, { type: 'dir', path: state.project || '', root: true });
});

function markActiveInTree(path) {
  $$('.tree-row').forEach(r => r.classList.toggle('active', r.dataset.path === path));
}

/* ---------------- context menu ---------------- */

function showCtxMenu(x, y, node) {
  const menu = $('#ctx-menu');
  menu.innerHTML = '';
  const items = [];
  const base = node.path ? node.path + '/' : '';
  if (node.type === 'dir') {
    items.push(['New file here', () => promptModal('NEW FILE', base, v => createEntry(v, 'file'))]);
    items.push(['New folder here', () => promptModal('NEW FOLDER', base, v => createEntry(v, 'dir'))]);
  }
  if (!node.root) {
    items.push(['Rename', () => promptModal('RENAME', node.path, v => renameEntry(node.path, v))]);
    items.push(['Delete', () => deleteEntry(node), 'danger']);
  }
  for (const [label, fn, cls] of items) {
    const it = document.createElement('div');
    it.className = 'ctx-item' + (cls ? ' ' + cls : '');
    it.textContent = label;
    it.addEventListener('click', () => { hideCtxMenu(); fn(); });
    menu.appendChild(it);
  }
  menu.style.left = Math.min(x, window.innerWidth - 170) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 140) + 'px';
  menu.hidden = false;
}
function hideCtxMenu() { $('#ctx-menu').hidden = true; }
document.addEventListener('click', hideCtxMenu);

async function createEntry(relPath, kind) {
  try {
    await postJson('/api/fs/create', { path: relPath, kind });
    await loadTree();
    if (kind === 'file') openFile(relPath);
  } catch (e) { toast(e.message, true); }
}

async function renameEntry(from, to) {
  try {
    await postJson('/api/fs/rename', { from, to });
    await loadTree();
    if (openFiles.has(from)) {
      const rec = openFiles.get(from);
      openFiles.delete(from);
      rec.path = to;
      openFiles.set(to, rec);
      if (state.activeFile === from) state.activeFile = to;
      renderTabs();
    }
  } catch (e) { toast(e.message, true); }
}

async function deleteEntry(node) {
  if (!confirm(`Delete ${node.path}?`)) return;
  try {
    await api('/api/fs/file?path=' + encodeURIComponent(node.path), { method: 'DELETE' });
    if (openFiles.has(node.path)) closeFile(node.path, true);
    await loadTree();
  } catch (e) { toast(e.message, true); }
}

/* ---------------- monaco + tabs ---------------- */

let monacoRef = null;
let editor = null;
const openFiles = new Map(); // path -> { path, model, dirty, savedVersionId }

const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json', html: 'html', css: 'css', scss: 'scss',
  md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'shell', svg: 'xml', xml: 'xml'
};

function initMonaco() {
  return new Promise(resolve => {
    require.config({ paths: { vs: 'vendor/monaco/vs' } });
    require(['vs/editor/editor.main'], () => {
      monacoRef = window.monaco;
      monacoRef.editor.defineTheme('er-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'comment', foreground: '5d6b81' },
          { token: 'string', foreground: '46e08a' },
          { token: 'keyword', foreground: '5aa2e0' },
          { token: 'number', foreground: 'e0b34a' }
        ],
        colors: {
          'editor.background': '#080b11',
          'editor.lineHighlightBackground': '#0c1018',
          'editorLineNumber.foreground': '#3a4658',
          'editorGutter.background': '#080b11',
          'editorCursor.foreground': '#46e08a',
          'editor.selectionBackground': '#1d4a3355'
        }
      });
      editor = monacoRef.editor.create($('#monaco-host'), {
        theme: 'er-dark',
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 12.5,
        minimap: { enabled: false },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'line',
        padding: { top: 8 },
        tabSize: 2,
        insertSpaces: true,
        autoIndent: 'full',
        formatOnPaste: true,
        autoClosingBrackets: 'always',
        autoClosingQuotes: 'always',
        bracketPairColorization: { enabled: true },
        quickSuggestions: { other: true, comments: false, strings: true },
        wordBasedSuggestions: 'currentDocument',
        suggestOnTriggerCharacters: true,
        tabCompletion: 'on'
      });
      editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyCode.KeyS, saveActiveFile);
      monacoRef.languages.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true });
      resolve();
    });
  });
}

async function openFile(path) {
  if (!monacoRef) return toast('Editor is not loaded - check for red errors in the console (Cmd+Option+J)', true);
  $('#editor-empty').style.display = 'none';
  if (openFiles.has(path)) {
    activateFile(path);
    return;
  }
  try {
    const data = await api('/api/fs/file?path=' + encodeURIComponent(path));
    const ext = path.split('.').pop().toLowerCase();
    const model = monacoRef.editor.createModel(data.content, LANG_BY_EXT[ext] || 'plaintext');
    const rec = { path, model, dirty: false, savedVersionId: model.getAlternativeVersionId() };
    model.onDidChangeContent(() => {
      const nowDirty = model.getAlternativeVersionId() !== rec.savedVersionId;
      if (nowDirty !== rec.dirty) { rec.dirty = nowDirty; renderTabs(); }
    });
    openFiles.set(path, rec);
    activateFile(path);
  } catch (e) { toast(e.message, true); }
}

function activateFile(path) {
  const rec = openFiles.get(path);
  if (!rec) return;
  state.activeFile = path;
  editor.setModel(rec.model);
  editor.focus();
  $('#status-file').textContent = path;
  markActiveInTree(path);
  renderTabs();
}

function closeFile(path, force) {
  const rec = openFiles.get(path);
  if (!rec) return;
  if (rec.dirty && !force && !confirm(`${path} has unsaved changes. Close anyway?`)) return;
  rec.model.dispose();
  openFiles.delete(path);
  if (state.activeFile === path) {
    const next = openFiles.keys().next().value || null;
    state.activeFile = next;
    if (next) activateFile(next);
    else {
      editor.setModel(null);
      $('#editor-empty').style.display = 'flex';
      $('#status-file').textContent = '';
      markActiveInTree(null);
    }
  }
  renderTabs();
}

async function saveActiveFile() {
  const rec = openFiles.get(state.activeFile);
  if (!rec) return;
  try {
    await api('/api/fs/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: rec.path, content: rec.model.getValue() })
    });
    rec.savedVersionId = rec.model.getAlternativeVersionId();
    rec.dirty = false;
    renderTabs();
  } catch (e) { toast(e.message, true); }
}

function renderTabs() {
  const host = $('#tabs');
  host.innerHTML = '';
  for (const [path, rec] of openFiles) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (path === state.activeFile ? ' active' : '');
    const name = document.createElement('span');
    name.textContent = path.split('/').pop();
    tab.appendChild(name);
    if (rec.dirty) {
      const d = document.createElement('span');
      d.className = 'dirty';
      d.textContent = '●';
      tab.appendChild(d);
    }
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '✕';
    close.addEventListener('click', ev => { ev.stopPropagation(); closeFile(path); });
    tab.appendChild(close);
    tab.addEventListener('click', () => activateFile(path));
    tab.title = path;
    host.appendChild(tab);
  }
}

/* ---------------- run controls ---------------- */

$('#btn-run').addEventListener('click', async () => {
  if (!state.project) return toast('Select or create a project first', true);
  // auto-save dirty files before launch
  for (const [, rec] of openFiles) if (rec.dirty) { state.activeFile = rec.path; await saveActiveFile(); }
  try { await postJson('/api/run/start', { project: state.project }); }
  catch (e) { toast(e.message, true); }
});

$('#btn-stop').addEventListener('click', () => postJson('/api/run/stop').catch(e => toast(e.message, true)));

$('#btn-restart').addEventListener('click', () => {
  postJson('/api/run/restart', { project: state.project }).catch(e => toast(e.message, true));
});

$('#btn-pack').addEventListener('click', () => {
  if (!state.project) return toast('Select a project first', true);
  toast('Packing - output in PROCESS LOG');
  postJson('/api/job/pack', { project: state.project }).catch(e => toast(e.message, true));
});

/* ---------------- glasses mirror ---------------- */

const canvas = $('#glasses-canvas');
const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
let prevFrame = null;
let frameTimes = [];
let mirrorBusy = false;
let lastAnalysis = 0;

async function mirrorTick() {
  if (!state.running || mirrorBusy) return;
  mirrorBusy = true;
  const t0 = performance.now();
  try {
    const res = await fetch('/api/sim/screenshot', { cache: 'no-store' });
    if (!res.ok) throw new Error('offline');
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    $('#lens').classList.add('live');

    const now = performance.now();
    frameTimes.push(now);
    frameTimes = frameTimes.filter(t => now - t < 3000);
    const fps = (frameTimes.length / 3).toFixed(1);
    $('#lens-fps').textContent = fps + ' FPS';
    $('#m-fps').textContent = fps + ' fps';
    $('#m-latency').textContent = (now - t0).toFixed(0) + ' ms/frame fetch';

    // Pixel analysis is expensive (165k px) - run it at 2 Hz, not per frame.
    if (now - lastAnalysis > 500) {
      lastAnalysis = now;
      const img = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
      let lit = 0, delta = 0;
      const d = img.data;
      for (let i = 3; i < d.length; i += 4) {
        const on = d[i] > 0;
        if (on) lit++;
        if (prevFrame) { if (on !== (prevFrame[i] > 0)) delta++; }
      }
      prevFrame = d;
      $('#m-lit').textContent = lit.toLocaleString();
      $('#m-lit-pct').textContent = ((lit / (576 * 288)) * 100).toFixed(1) + '% of framebuffer';
      $('#m-delta').textContent = delta.toLocaleString();

      if (!state.firstRenderAt && lit > 100 && state.simStartedAt) {
        state.firstRenderAt = Date.now();
        $('#m-boot').textContent = ((state.firstRenderAt - state.simStartedAt) / 1000).toFixed(1) + ' s';
      }
    }
  } catch {
    $('#lens').classList.remove('live');
    $('#lens-fps').textContent = '0.0 FPS';
    await new Promise(r => setTimeout(r, 400)); // back off while sim is down
  } finally {
    mirrorBusy = false;
  }
}
// Continuous loop: 15ms tick + busy guard means the next frame is requested
// as soon as the previous one lands - throughput tracks the sim endpoint.
setInterval(mirrorTick, 15);

$('#chk-glow').addEventListener('change', ev => {
  $('#lens').classList.toggle('glow', ev.target.checked);
});
$('#lens').classList.add('glow');

$('#btn-snap').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `g2-frame-${Date.now()}.png`;
  a.click();
});

$$('.pad-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    postJson('/api/sim/input', { action: btn.dataset.action })
      .catch(() => toast('Simulator not reachable - input dropped', true));
  });
});

/* ---------------- glasses console ---------------- */

async function consoleTick() {
  if (!state.running) return;
  try {
    const data = await api('/api/sim/console?since_id=' + state.consoleSinceId);
    const entries = (data && data.entries) || [];
    if (entries.length === 0) return;
    const host = $('#glasses-log');
    const stick = host.scrollTop + host.clientHeight >= host.scrollHeight - 30;
    for (const e of entries) {
      state.consoleSinceId = Math.max(state.consoleSinceId, e.id || 0);
      const level = (e.level || e.type || 'log').toLowerCase();
      if (level.includes('err')) state.errCount++;
      else if (level.includes('warn')) state.warnCount++;
      const line = document.createElement('div');
      line.className = 'log-line' + (level.includes('err') ? ' lvl-error' : level.includes('warn') ? ' lvl-warn' : '');
      const ts = document.createElement('span');
      ts.className = 'log-ts';
      ts.textContent = new Date(e.timestamp || Date.now()).toLocaleTimeString('en-GB');
      line.appendChild(ts);
      line.appendChild(document.createTextNode(String(e.message ?? JSON.stringify(e))));
      host.appendChild(line);
    }
    while (host.children.length > 2000) host.removeChild(host.firstChild);
    if (stick) host.scrollTop = host.scrollHeight;
    updateBadges();
  } catch { /* sim offline */ }
}
setInterval(consoleTick, 500);

function updateBadges() {
  $('#badge-console').textContent = state.errCount > 0 ? String(state.errCount) : '';
  $('#m-errors').textContent = String(state.errCount);
  $('#m-warns').textContent = state.warnCount + ' warnings';
}

/* ---------------- process log ---------------- */

function appendProcLog(source, line, ts) {
  const host = $('#process-log');
  const stick = host.scrollTop + host.clientHeight >= host.scrollHeight - 30;
  const el = document.createElement('div');
  const lower = line.toLowerCase();
  el.className = 'log-line' + (lower.includes('error') || lower.includes('err!') ? ' lvl-error' : lower.includes('warn') ? ' lvl-warn' : '');
  const src = document.createElement('span');
  src.className = 'log-src src-' + source;
  src.textContent = source.toUpperCase().padEnd(4);
  el.appendChild(src);
  el.appendChild(document.createTextNode(line));
  host.appendChild(el);
  while (host.children.length > 3000) host.removeChild(host.firstChild);
  if (stick) host.scrollTop = host.scrollHeight;

  state.procLogCount++;
  if (!$('#dock-process').classList.contains('active')) {
    $('#badge-process').textContent = state.procLogCount > 99 ? '99+' : String(state.procLogCount);
  }
}

/* ---------------- dock ---------------- */

$$('.dock-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.dock-tab').forEach(t => t.classList.remove('active'));
    $$('.dock-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $('#dock-' + tab.dataset.dock).classList.add('active');
    if (tab.dataset.dock === 'process') { state.procLogCount = 0; $('#badge-process').textContent = ''; }
    if (tab.dataset.dock === 'terminal' && fitAddon) fitAddon.fit();
  });
});

$('#btn-dock-clear').addEventListener('click', () => {
  const active = $('.dock-panel.active');
  if (active.id === 'dock-terminal' && term) term.clear();
  if (active.id === 'dock-process') { $('#process-log').innerHTML = ''; }
  if (active.id === 'dock-glasses-console') {
    $('#glasses-log').innerHTML = '';
    api('/api/sim/console', { method: 'DELETE' }).catch(() => {});
    state.errCount = 0; state.warnCount = 0;
    updateBadges();
  }
});

/* ---------------- terminal ---------------- */

function initTerminal() {
  term = new Terminal({
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 12,
    theme: {
      background: '#0c1018',
      foreground: '#c6cfdc',
      cursor: '#46e08a',
      selectionBackground: '#1d4a3388'
    },
    cursorBlink: true
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($('#xterm-host'));
  fitAddon.fit();
  term.onData(data => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'term-input', data }));
  });
  term.onResize(({ cols, rows }) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'term-resize', cols, rows }));
  });
  window.addEventListener('resize', () => fitAddon.fit());
}

/* ---------------- metrics timers ---------------- */

setInterval(() => {
  if (state.running && state.startedAt) {
    const s = Math.floor((Date.now() - state.startedAt) / 1000);
    $('#m-uptime').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  } else {
    $('#m-uptime').textContent = '—';
  }
}, 1000);

setInterval(async () => {
  try {
    const h = await api('/api/metrics/host');
    $('#m-host').textContent = h.rssMb + ' MB';
  } catch { /* server unreachable */ }
}, 5000);

/* ---------------- modals ---------------- */

function promptModal(title, initial, onOk) {
  $('#mp-title').textContent = title;
  const input = $('#mp-input');
  input.value = initial || '';
  $('#modal-prompt').hidden = false;
  input.focus();
  const done = ok => {
    $('#modal-prompt').hidden = true;
    okBtn.removeEventListener('click', okH);
    cancelBtn.removeEventListener('click', cancelH);
    input.removeEventListener('keydown', keyH);
    if (ok && input.value.trim()) onOk(input.value.trim());
  };
  const okBtn = $('#mp-ok'), cancelBtn = $('#mp-cancel');
  const okH = () => done(true);
  const cancelH = () => done(false);
  const keyH = e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  okBtn.addEventListener('click', okH);
  cancelBtn.addEventListener('click', cancelH);
  input.addEventListener('keydown', keyH);
}

$('#btn-new-file').addEventListener('click', () => promptModal('NEW FILE (path relative to workspace)', state.project ? state.project + '/' : '', v => createEntry(v, 'file')));
$('#btn-new-dir').addEventListener('click', () => promptModal('NEW FOLDER (path relative to workspace)', state.project ? state.project + '/' : '', v => createEntry(v, 'dir')));
$('#btn-refresh-tree').addEventListener('click', () => loadTree().catch(e => toast(e.message, true)));
$('#btn-webview-reload').addEventListener('click', () => { const f = $('#webview'); f.src = f.src; });

$('#btn-new-project').addEventListener('click', () => { $('#modal-new').hidden = false; $('#np-name').focus(); });
$('#np-cancel').addEventListener('click', () => { $('#modal-new').hidden = true; });
$$('#np-templates .template-card').forEach(card => {
  card.addEventListener('click', () => {
    $$('#np-templates .template-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
  });
});
$('#np-create').addEventListener('click', async () => {
  const name = $('#np-name').value.trim();
  const template = $('#np-templates .selected').dataset.t;
  if (!name) return toast('Project name required', true);
  try {
    await postJson('/api/job/scaffold', { name, template });
    $('#modal-new').hidden = true;
    toast(`Scaffolding "${name}" from ${template} - progress in PROCESS LOG`);
  } catch (e) { toast(e.message, true); }
});

$('#project-select').addEventListener('change', onProjectChange);

/* ---------------- boot ---------------- */

(async function boot() {
  if (navigator.userAgent.includes('Electron')) document.body.classList.add('electron');
  connectWs();
  try { initTerminal(); } catch (e) { toast('Terminal init failed: ' + e.message, true); }
  try { await initMonaco(); } catch (e) { toast('Editor init failed: ' + e.message, true); }
  try {
    await loadProjects();
    await loadTree();
  } catch (e) { toast(e.message, true); }
})();
