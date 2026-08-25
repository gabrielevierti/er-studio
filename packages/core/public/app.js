/* ER Studio - frontend
   Single-origin UI over the local ER Studio server:
   - /api/fs      workspace file system
   - /api/run     vite + simulator session control
   - /api/sim     proxy to simulator automation control plane
   - /ws          status, process logs, terminal
*/

'use strict';

/* Panels can be torn off into their own OS windows (panels.js). When that
   happens the panel's DOM moves into that window's document, so a plain
   document.querySelector would stop finding it. Every lookup therefore walks
   the main document first and then any detached panel documents - which is
   what keeps the several hundred $('#...') calls below working unchanged. */

const detachedDocs = new Set();
window.__erDocs = detachedDocs;

/* ---------------- theme colours ----------------
   CSS handles every surface the browser paints. These three do not go through
   CSS - Monaco, xterm and the metrics sparklines each want colours handed to
   them as strings - so they read the same tokens theme.css defines and
   re-read them whenever the host theme changes.

   Resolving through a probe element rather than getPropertyValue is
   deliberate: a token may land on a hex, an rgb(), or an 8-digit hex
   depending on the theme, and `color` normalises all of them to one form. */

function resolveColour(token, fallback) {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  probe.style.color = fallback;
  probe.style.color = `var(${token}, ${fallback})`;
  (document.body || document.documentElement).appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value || fallback;
}

/** Same, as #rrggbb - Monaco and xterm both reject rgb() notation. */
function resolveHex(token, fallback) {
  const parts = resolveColour(token, fallback).match(/[\d.]+/g);
  if (!parts || parts.length < 3) return fallback;
  const hex = n => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0');
  const alpha = parts.length > 3 ? Number(parts[3]) : 1;
  const base = '#' + hex(parts[0]) + hex(parts[1]) + hex(parts[2]);
  return alpha >= 1 ? base : base + hex(alpha * 255);
}

/** Monaco token rules want a bare 6-digit hex with no leading hash. */
function resolveToken(token, fallback) {
  return resolveHex(token, fallback).slice(1, 7);
}

const $ = sel => {
  const hit = document.querySelector(sel);
  if (hit) return hit;
  for (const doc of detachedDocs) {
    try {
      const found = doc.querySelector(sel);
      if (found) return found;
    } catch { /* window torn down mid-lookup */ }
  }
  return null;
};

const $$ = sel => {
  const out = Array.from(document.querySelectorAll(sel));
  for (const doc of detachedDocs) {
    try { out.push(...doc.querySelectorAll(sel)); } catch { /* torn down */ }
  }
  return out;
};

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
  procLogCount: 0,
  doctorBusy: false,
  fixBusy: false,
  frames: 0
};

/* ---------------- sampled history for the metrics panel ----------------
   One fixed-length ring per series. Sparklines read straight off these, so
   nothing is recomputed when the panel opens and nothing is retained when it
   is closed - the sampling already happens for the mirror either way. */

const HISTORY_LEN = 120;
const history = { fps: [], latency: [], lit: [], delta: [], rss: [] };

function pushSample(series, value) {
  const arr = history[series];
  if (!arr || !Number.isFinite(value)) return;
  arr.push(value);
  if (arr.length > HISTORY_LEN) arr.shift();
}

function resetHistory() {
  for (const key of Object.keys(history)) history[key].length = 0;
  paintSparks();
}

// Nearest-rank, which is honest about small samples: with 8 frames recorded
// there is no p95 worth interpolating towards.
function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))];
}

/* ---------------- fetch version from the server ---------------- */

async function fetchVersion() {
  try {
    const response = await fetch('/api/version');
    const data = await response.json();
    document.getElementById('version-display').textContent = data.version;
  } catch (error) {
    console.warn('Could not fetch version:', error);
    document.getElementById('version-display').textContent = '—';
  }
}

document.addEventListener('DOMContentLoaded', fetchVersion);

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
    $('#status-conn').textContent = 'Connected';
    $('#status-conn').dataset.state = 'on';
  };

  ws.onclose = () => {
    $('#status-conn').textContent = 'Disconnected';
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
        {
          const wsBar = $('#bar-workspace-path');
          if (wsBar) {
            wsBar.textContent = msg.workspace.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
            wsBar.title = msg.workspace;
          }
        }
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
          refreshSdk(); 
        }, 250);
        break;
      case 'fix-progress':
        setFixProgress(`${msg.done}/${msg.total}${msg.code === 0 ? '' : ' \u00b7 last failed'}`);
        break;
      case 'job-done':
        if (msg.kind === 'fixes') {
          state.fixBusy = false;
          setFixProgress('');
          const results = msg.results || [];
          const failed = results.filter(r => r.code !== 0);
          renderFixResults(results);
          toast(
            failed.length
              ? `${failed.length} of ${results.length} fixes failed - see CONSOLE`
              : `${results.length} fix${results.length === 1 ? '' : 'es'} applied`,
            failed.length > 0
          );
          // Re-run so the panel shows reality, not the report that triggered this.
          runDoctor().catch(() => {});
          break;
        }
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
      case 'term-mode': {
        const modeBar = $('#bar-terminal-mode');
        if (modeBar) modeBar.textContent = msg.mode === 'exec' ? 'command runner - no pty' : 'interactive shell';
        if (term && msg.mode === 'exec') {
          term.writeln('\x1b[33m' + msg.note + '\x1b[0m');
        }
        break;
      }
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

  refreshSdk();  

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
  const urlBar = $('#bar-webview-url');
  if (s.viteUrl) {
    if (frame.src !== s.viteUrl) frame.src = s.viteUrl;
    $('#btn-webview-open').href = s.viteUrl;
    if (urlBar) urlBar.textContent = s.viteUrl;
    wrap.classList.add('live');
  } else {
    frame.src = 'about:blank';
    $('#btn-webview-open').removeAttribute('href');
    if (urlBar) urlBar.textContent = 'dev server offline';
    wrap.classList.remove('live');
  }

  paintSessionMetrics(s);

  if (!wasRunning && s.running) {
    state.firstRenderAt = null;
    state.consoleSinceId = 0;
    state.errCount = 0;
    state.warnCount = 0;
    state.frames = 0;
    fetchTimes.length = 0;
    resetHistory();
    updateBadges();
    $('#m-boot').textContent = '\u2014';
  }
  if (wasRunning && !s.running) {
    $('#lens').classList.remove('live');
    clearMirror();
  }
}

/* ---------------- metrics: session block ----------------
   Everything here comes off the status message, so it stays correct whether
   or not the METRICS panel has ever been opened. */

function paintSessionMetrics(s) {
  const stateEl = $('#m-state');
  if (stateEl) {
    const mode = s.running ? (s.simAlive ? 'live' : 'starting') : 'idle';
    stateEl.dataset.state = mode;
    stateEl.textContent = mode.toUpperCase();
  }

  const project = $('#m-project');
  if (project) project.textContent = s.project || 'no project';

  const lensState = $('#lens-state');
  if (lensState) lensState.textContent = s.simAlive ? 'mirroring' : (s.running ? 'waiting for simulator' : 'idle');

  const vite = $('#m-vite');
  if (vite) {
    vite.textContent = s.vitePort ? ':' + s.vitePort : '\u2014';
    vite.className = 'metric-value mono' + (s.viteAlive ? ' metric-ok' : '');
    $('#m-vite-sub').textContent = s.viteAlive ? 'serving' : (s.running ? 'starting\u2026' : 'not running');
  }

  const sim = $('#m-sim');
  if (sim) {
    sim.textContent = s.simAlive ? ':' + s.simAutomationPort : '\u2014';
    sim.className = 'metric-value mono' + (s.simAlive ? ' metric-ok' : '');
    $('#m-sim-sub').textContent = s.simAlive ? 'automation API up' : (s.running ? 'not launched yet' : 'not running');
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
    opt.textContent = 'new project';
    sel.appendChild(opt);
  }
  for (const p of data.projects) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name + (p.hasManifest ? '' : '  [no app.json]');
    sel.appendChild(opt);
  }
  if (prev && data.projects.some(p => p.name === prev)) sel.value = prev;
  {
    refreshSdk();
    state.project = sel.value || null;
  }
}

const PROJECT_CHECK_IDS = ['project-package', 'project-deps', 'project-sdk', 'project-manifest'];

function onProjectChange() {
  state.project = $('#project-select').value || null;
  refreshSdk();
  // Only the project rows can have changed - leave the rest of the report alone.
  if (doctorReport) runDoctor(PROJECT_CHECK_IDS);
}

/* ---------------- sdk version ---------------- */

async function refreshSdk() {
  const el = $('#status-sdk');
  const q = encodeURIComponent(state.project || '');

  let report;
  try {
    report = await api(`/api/sdk?project=${q}`);
  } catch {
    el.textContent = 'sdk: ?';
    el.dataset.state = 'off';
    return;
  }

  paintSdk(el, report);

  // Update check is a second request so the bar paints from disk immediately
  // and the hint appears a moment later only if there is one.
  api(`/api/sdk?project=${q}&updates=1`)
    .then(full => paintSdk(el, full))
    .catch(() => {});
}

const SIM_MIN = '0.7.0';   // --automation-port, i.e. the live mirror

function paintSdk(el, report) {
  const sim  = report.global.simulator;
  const cli  = report.global.cli;
  const proj = report.project;

  // Tooltip carries everything; the label carries one thing.
  const lines = [];
  if (proj) {
    lines.push(proj.found
      ? `SDK ${proj.version}${proj.declared ? `   (declares ${proj.declared})` : ''}`
      : `SDK: ${proj.reason}`);
  } else {
    lines.push('SDK: no project selected');
  }
  for (const [name, e] of [['simulator', sim], ['cli', cli]]) {
    lines.push(e.found
      ? `${name} ${e.version} · ${e.source}${e.updateAvailable ? `  →  ${e.latest} available` : ''}`
      : `${name}: ${e.reason}`);
  }
  el.title = lines.join('\n');
  el.onclick = null;

  // --- tooling problems outrank the version, because they break RUN ---

  if (!sim.found) {
    el.textContent = 'simulator missing';
    el.dataset.state = 'error';
    el.title = 'Click to open DOCTOR for the full diagnosis\n\n' + el.title;
    el.onclick = openDoctor;
    return;
  }

  // Older simulators have no automation API: RUN starts, mirror stays blank.
  if (compareSemver(sim.version, SIM_MIN) < 0) {
    el.textContent = `simulator ${sim.version} — needs ${SIM_MIN}+`;
    el.dataset.state = 'error';
    el.title = 'The live glasses mirror needs the simulator automation API, '
             + `added in ${SIM_MIN}.\n\nClick to open DOCTOR.\n\n` + el.title;
    el.onclick = openDoctor;
    return;
  }

  // --- otherwise: the SDK version, which is the question being asked ---

  if (!proj) {
    el.textContent = 'sdk —';
    el.dataset.state = 'off';
  } else if (proj.declared && !proj.found) {
    el.textContent = 'sdk not installed';
    el.dataset.state = 'warn';
  } else if (proj.satisfies === false) {
    el.textContent = `sdk ${proj.version} ≠ ${proj.declared}`;
    el.dataset.state = 'warn';
  } else if (proj.found) {
    el.textContent = `sdk ${proj.version}`;
    el.dataset.state = 'ok';
  } else {
    el.textContent = 'sdk —';
    el.dataset.state = 'off';
  }
}

// Same rules as the server's comparator, small enough not to be worth an endpoint.
function compareSemver(a, b) {
  const ap = String(a).split('-')[0].split('.').map(Number);
  const bp = String(b).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const l = ap[i] || 0, r = bp[i] || 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

/* ---------------- doctor ----------------
   Diagnostics panel. Every row is one check from /api/doctor; a row can be
   re-run on its own without touching the rest of the report, and the whole
   thing flattens to plain text for pasting into Discord or a bug report.   */

const DOCTOR_AUTORUN_KEY = 'er-doctor-autorun';
let doctorReport = null;

function doctorAutorunEnabled() {
  return localStorage.getItem(DOCTOR_AUTORUN_KEY) !== '0';
}

function openDoctor() {
  const tab = $('.dock-tab[data-dock="doctor"]');
  if (tab) tab.click();
}

async function runDoctor(only) {
  const ids = Array.isArray(only) ? only : (only ? [only] : []);
  const partial = ids.length > 0;

  if (!partial && state.doctorBusy) return;
  if (!partial) {
    state.doctorBusy = true;
    $('#btn-doctor-run').disabled = true;
    $('#doctor-summary').textContent = 'running checks…';
    if (!doctorReport) {
      $('#doctor-list').innerHTML = '<div class="doctor-empty">Checking your environment…</div>';
    }
  } else {
    for (const id of ids) {
      const row = $(`.doctor-row[data-id="${id}"]`);
      if (row) row.classList.add('busy');
    }
  }

  const params = new URLSearchParams({ project: state.project || '' });
  if (partial) params.set('only', ids.join(','));

  try {
    const report = await api('/api/doctor?' + params.toString());
    if (partial) patchDoctorChecks(report.checks);
    else renderDoctor(report);
    return report;
  } catch (err) {
    if (partial) {
      for (const id of ids) {
        const row = $(`.doctor-row[data-id="${id}"]`);
        if (row) row.classList.remove('busy');
      }
      toast('Could not re-run that check: ' + err.message, true);
    } else {
      $('#doctor-list').innerHTML = '';
      const box = document.createElement('div');
      box.className = 'doctor-empty';
      box.textContent = 'The diagnostics endpoint did not answer (' + err.message +
        '). The ER Studio server itself may have stopped - check the terminal it was started from.';
      $('#doctor-list').appendChild(box);
      $('#doctor-summary').textContent = 'unavailable';
    }
  } finally {
    if (!partial) {
      state.doctorBusy = false;
      $('#btn-doctor-run').disabled = false;
    }
  }
}


/* ---------------- doctor: applying fixes ---------------- */

// Only checks whose fix the server marked `auto: true` are offered. A passing
// check can carry a TIP, which is not something to run.
function isAutoFix(check) {
  return !!(check.fix && check.fix.auto === true && check.fix.command &&
            check.status !== 'pass' && check.status !== 'skip');
}

// Runnable from its own row, but deliberately not part of RUN FIXES: the user
// should be choosing this one specifically, not sweeping it up in a batch.
function isRowFix(check) {
  return !!(check.fix && (check.fix.auto === true || check.fix.auto === 'confirm') &&
            check.fix.command && check.status !== 'pass' && check.status !== 'skip');
}

function pendingFixes() {
  return doctorReport ? doctorReport.checks.filter(isAutoFix) : [];
}

function setFixProgress(text) {
  const el = $('#doctor-fix-progress');
  if (el) el.textContent = text;
}

function paintFixButton() {
  const btn = $('#btn-doctor-fix');
  if (!btn) return;
  // Count commands, not checks: two checks often propose the same install
  // line, and the batch runs it once. Showing 3 then listing 2 looks broken.
  const commands = [...new Set(pendingFixes().map(c => c.fix.command))];
  btn.disabled = state.fixBusy || state.doctorBusy || commands.length === 0;
  btn.textContent = state.fixBusy ? 'RUNNING\u2026'
    : commands.length ? `RUN FIXES (${commands.length})` : 'RUN FIXES';
  btn.title = commands.length
    ? `Run ${commands.length} command${commands.length === 1 ? '' : 's'}:\n` +
      commands.map(c => '\u00b7 ' + c).join('\n')
    : (() => {
        const manual = (doctorReport ? doctorReport.checks : [])
          .filter(c => c.fix && c.fix.command && !isAutoFix(c) &&
                       c.status !== 'pass' && c.status !== 'skip');
        return manual.length
          ? `${manual.length} fix${manual.length === 1 ? '' : 'es'} need running one at a time:\n` +
            manual.map(c => '\u00b7 ' + c.label).join('\n')
          : 'Nothing to fix - all checks pass';
      })();
}

// The server takes check ids, never commands: it re-runs those checks and
// executes only what they report as auto-runnable. So a stale report cannot
// run a command for a problem that is already fixed, and nothing here can
// widen into arbitrary shell.
async function runFixes(ids) {
  if (state.fixBusy || !ids.length || !doctorReport) return;

  const commands = [...new Set(
    doctorReport.checks.filter(c => ids.includes(c.id) && isRowFix(c)).map(c => c.fix.command)
  )];
  if (!commands.length) return;

  // Running shell on someone's machine should never be one unlabelled click.
  // The modal lists every command against the check that asked for it, so the
  // question being answered is "do I want this to happen to my machine", not
  // "what does this button do".
  const proceed = await confirmFixes(
    doctorReport.checks.filter(c => ids.includes(c.id) && isAutoFix(c))
  );
  if (!proceed) return;

  state.fixBusy = true;
  paintFixButton();
  setFixProgress('starting\u2026');

  const consoleTab = $('.dock-tab[data-dock="process"]');
  if (consoleTab) consoleTab.click();   // the output is the point

  try {
    const res = await postJson('/api/job/fixes', { ids, project: state.project });
    if (res.total === 0) {
      state.fixBusy = false;
      setFixProgress('');
      paintFixButton();
      toast(res.note || 'Nothing left to fix');
      runDoctor().catch(() => {});
    }
  } catch (e) {
    state.fixBusy = false;
    setFixProgress('');
    paintFixButton();
    toast(e.message, true);
  }
}

/* ---------------- doctor: fix preview and outcome ---------------- */

// Resolves true only when the user reads the list and accepts it.
function confirmFixes(checks) {
  return new Promise(resolve => {
    const modal = $('#modal-fixes');
    const list = $('#fx-list');
    if (!modal || !list) return resolve(false);

    // Two checks often propose the same install line; it runs once, so show
    // it once, with every check that wanted it.
    const byCommand = new Map();
    for (const check of checks) {
      if (!byCommand.has(check.fix.command)) byCommand.set(check.fix.command, []);
      byCommand.get(check.fix.command).push(check);
    }

    const n = byCommand.size;
    $('#fx-lead').textContent =
      `${n} command${n === 1 ? '' : 's'} will run on your machine, in order. ` +
      'A command that fails does not stop the ones after it.';

    list.innerHTML = '';
    let index = 0;
    for (const [command, owners] of byCommand) {
      const row = document.createElement('div');
      row.className = 'fix-row';

      const num = document.createElement('span');
      num.className = 'fix-num mono';
      num.textContent = String(++index);

      const body = document.createElement('div');

      const why = document.createElement('div');
      why.className = 'fix-why';
      why.textContent = owners.map(o => o.label).join(' \u00b7 ');

      const code = document.createElement('code');
      code.className = 'fix-cmd';
      code.textContent = command;

      body.append(why, code);
      row.append(num, body);
      list.appendChild(row);
    }

    const ok = $('#fx-run');
    const cancel = $('#fx-cancel');

    const done = answer => {
      modal.hidden = true;
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(answer);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onKey = ev => {
      if (ev.key === 'Escape') done(false);
      if (ev.key === 'Enter') done(true);
    };

    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);

    modal.hidden = false;
    ok.focus();
  });
}

// A toast disappears; which command failed is worth keeping on screen until
// the next run replaces it.
function renderFixResults(results) {
  const host = $('#doctor-results');
  if (!host) return;
  host.innerHTML = '';

  if (!results.length) { host.hidden = true; return; }

  const failed = results.filter(r => r.code !== 0);
  const head = document.createElement('div');
  head.className = 'fix-result-head';
  head.textContent = failed.length
    ? `${results.length - failed.length} of ${results.length} fixes applied, ${failed.length} failed - full output in CONSOLE`
    : `${results.length} fix${results.length === 1 ? '' : 'es'} applied`;
  host.appendChild(head);

  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'fix-result' + (r.code === 0 ? ' ok' : ' bad');
    const tag = document.createElement('span');
    tag.className = 'fix-result-tag mono';
    tag.textContent = r.code === 0 ? 'OK' : 'FAIL';
    const code = document.createElement('code');
    code.textContent = r.command;
    row.append(tag, code);
    host.appendChild(row);
  }

  const dismiss = document.createElement('button');
  dismiss.className = 'icon-btn fix-result-dismiss';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => { host.hidden = true; });
  host.appendChild(dismiss);

  host.hidden = false;
}

function renderDoctor(report) {
  doctorReport = report;
  const host = $('#doctor-list');
  host.innerHTML = '';

  let currentGroup = null;
  for (const check of report.checks) {
    if (check.group !== currentGroup) {
      currentGroup = check.group;
      const head = document.createElement('div');
      head.className = 'doctor-group';
      head.textContent = currentGroup.toUpperCase();
      host.appendChild(head);
    }
    host.appendChild(buildDoctorRow(check));
  }

  $('#btn-doctor-copy').disabled = false;
  paintDoctorSummary();
  paintFixButton();
}

// Partial run: swap only the rows we asked for, keep everything else on screen.
function patchDoctorChecks(checks) {
  for (const check of checks) {
    const old = $(`.doctor-row[data-id="${check.id}"]`);
    if (old) old.replaceWith(buildDoctorRow(check));
    if (doctorReport) {
      const i = doctorReport.checks.findIndex(c => c.id === check.id);
      if (i !== -1) doctorReport.checks[i] = check;
    }
  }
  paintDoctorSummary();
  paintFixButton();
}

function buildDoctorRow(check) {
  const row = document.createElement('div');
  row.className = 'doctor-row';
  row.dataset.status = check.status;
  row.dataset.id = check.id;

  const status = document.createElement('div');
  status.className = 'doctor-status';
  status.textContent = check.status.toUpperCase();

  const body = document.createElement('div');

  const label = document.createElement('div');
  label.className = 'doctor-label';
  label.textContent = check.label;

  const message = document.createElement('div');
  message.className = 'doctor-message';
  message.textContent = check.message;
  body.append(label, message);

  if (check.detail) {
    const detail = document.createElement('div');
    detail.className = 'doctor-detail';
    detail.textContent = check.detail;
    body.appendChild(detail);
  }

  if (check.fix) {
    const fix = document.createElement('div');
    fix.className = 'doctor-fix';

    if (check.fix.text) {
      const tag = document.createElement('span');
      tag.className = 'doctor-fix-tag';
      // A passing check can still carry a suggestion - don't call that a fix.
      tag.textContent = (check.status === 'pass' || check.status === 'skip') ? 'TIP' : 'FIX';
      fix.append(tag, document.createTextNode(check.fix.text));
    }

    if (check.fix.url) {
      const link = document.createElement('a');
      link.className = 'doctor-link';
      link.href = check.fix.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Docs \u2197';
      fix.append(document.createTextNode(' '), link);
    }

    if (check.fix.command) {
      const cmdWrap = document.createElement('div');
      cmdWrap.className = 'doctor-cmd';
      const code = document.createElement('code');
      code.textContent = check.fix.command;
      const copy = document.createElement('button');
      copy.className = 'doctor-rerun';
      copy.textContent = 'Copy';
      copy.title = 'Copy this command';
      copy.addEventListener('click', () => {
        copyText(check.fix.command).then(ok => toast(ok ? 'Command copied' : 'Could not copy', !ok));
      });
      cmdWrap.append(code, copy);

      if (isRowFix(check)) {
        const run = document.createElement('button');
        run.className = 'doctor-rerun doctor-runfix';
        run.textContent = 'Run';
        run.title = 'Run this command now';
        run.addEventListener('click', () => runFixes([check.id]));
        cmdWrap.appendChild(run);
      } else if (check.status !== 'pass' && check.status !== 'skip') {
        // Without this, a missing RUN button reads as a bug rather than a decision.
        const manual = document.createElement('span');
        manual.className = 'doctor-manual';
        manual.textContent = 'Manual';
        manual.title = 'Not run automatically: this edits files outside the workspace, changes permissions, or stops a process. Read it before you run it.';
        cmdWrap.appendChild(manual);
      }

      fix.appendChild(cmdWrap);
    }

    body.appendChild(fix);
  }

  const rerun = document.createElement('button');
  rerun.className = 'doctor-rerun';
  rerun.textContent = '\u21bb';
  rerun.title = 'Re-run this check';
  rerun.addEventListener('click', () => runDoctor(check.id));

  row.append(status, body, rerun);
  return row;
}

function paintDoctorSummary() {
  if (!doctorReport) return;

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of doctorReport.checks) counts[c.status] = (counts[c.status] || 0) + 1;
  doctorReport.summary = counts;

  const el = $('#doctor-summary');
  el.innerHTML = '';
  const parts = [
    ['s-fail', counts.fail, 'failed'],
    ['s-warn', counts.warn, 'warning' + (counts.warn === 1 ? '' : 's')],
    ['s-pass', counts.pass, 'passed'],
    ['', counts.skip, 'skipped']
  ].filter(([, n]) => n > 0);

  parts.forEach(([cls, n, word], i) => {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = `${n} ${word}`;
    el.appendChild(span);
    if (i < parts.length - 1) el.appendChild(document.createTextNode(' \u00b7 '));
  });

  const badge = $('#badge-doctor');
  badge.className = 'badge' + (counts.fail ? ' badge-err' : counts.warn ? ' badge-warn' : '');
  badge.textContent = counts.fail ? String(counts.fail) : counts.warn ? String(counts.warn) : '';
}

// Plain text, home directory redacted - these get pasted in public channels.
function doctorReportText() {
  if (!doctorReport) return '';
  const env = doctorReport.env;
  const home = env.home;
  const scrub = text => (home ? String(text).split(home).join('~') : String(text));
  // Commands stay paste-able after redaction: "~" does not expand inside
  // double quotes, "$HOME" does.
  const scrubCmd = text => (home ? String(text).split(home).join('$HOME') : String(text));

  const lines = [];
  lines.push(`ER Studio ${env.erStudio || '?'} - environment report`);
  lines.push(`generated  ${doctorReport.generatedAt}`);
  lines.push(`platform   ${env.platform}`);
  lines.push(`node       ${env.node}${env.electron ? `  (electron ${env.electron})` : ''}`);
  lines.push(`workspace  ${scrub(env.workspace)}`);
  lines.push(`project    ${env.project || '(none selected)'}`);
  lines.push('');

  const s = doctorReport.summary;
  lines.push(`${s.fail} failed, ${s.warn} warning${s.warn === 1 ? '' : 's'}, ${s.pass} passed, ${s.skip} skipped`);
  lines.push('');

  for (const c of doctorReport.checks) {
    lines.push(`[${c.status.toUpperCase().padEnd(4)}] ${c.label} - ${scrub(c.message)}`);
    if (c.detail) {
      for (const line of scrub(c.detail).split('\n')) lines.push('         ' + line.trim());
    }
    const hint = (c.status === 'pass' || c.status === 'skip') ? 'tip: ' : 'fix: ';
    if (c.fix && c.fix.text) lines.push('         ' + hint + scrub(c.fix.text));
    if (c.fix && c.fix.command) lines.push('         $ ' + scrubCmd(c.fix.command));
    if (c.fix && c.fix.url) lines.push('         ' + c.fix.url);
  }

  return lines.join('\n');
}

// navigator.clipboard needs a secure context; 127.0.0.1 counts, but the
// browser-mode origin can still refuse, so keep a fallback.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

$('#btn-doctor-run').addEventListener('click', () => runDoctor());

// Optional chaining on purpose: this button is the newest addition to
// index.html, and a null here at top level would abort the rest of app.js -
// every listener below, and boot() itself.
$('#btn-doctor-fix')?.addEventListener('click', () => runFixes(pendingFixes().map(c => c.id)));

$('#btn-doctor-copy').addEventListener('click', async () => {
  const text = doctorReportText();
  if (!text) return toast('Run the checks first', true);
  const ok = await copyText(text);
  toast(ok ? 'Report copied to clipboard' : 'Could not access the clipboard', !ok);
});

$('#doctor-autorun').addEventListener('change', ev => {
  localStorage.setItem(DOCTOR_AUTORUN_KEY, ev.target.checked ? '1' : '0');
});

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

function resolveFontFamily(token, fallback) {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  probe.style.fontFamily = `var(${token}, ${fallback})`;
  (document.body || document.documentElement).appendChild(probe);
  const value = getComputedStyle(probe).fontFamily;
  probe.remove();
  return value || fallback;
}

function resolveFontSize(token, fallback) {
  const raw = window.ERTheme ? window.ERTheme.token(token, '') : '';
  const size = parseFloat(raw);
  return Number.isFinite(size) && size > 0 ? size : fallback;
}

/* The workbench exposes its *workbench* colours to a webview but not its
   syntax theme, so the chrome around the editor matches exactly and the
   tokens are a close read: strings and numbers borrow the colours the debug
   views use for the same things, keywords borrow the symbol icon colour.
   Better an honest approximation from the live theme than a fixed palette
   that is wrong in every theme but one. */
function applyMonacoTheme() {
  if (!monacoRef) return;

  const kind = window.ERTheme ? window.ERTheme.kind() : null;
  const base =
    kind === 'vscode-light' ? 'vs' :
    kind === 'vscode-high-contrast' ? 'hc-black' :
    kind === 'vscode-high-contrast-light' ? 'hc-light' :
    'vs-dark';

  const bg = resolveHex('--vscode-editor-background', '#080b11');

  monacoRef.editor.defineTheme('er-editor', {
    base,
    inherit: true,
    rules: [
      { token: 'comment', foreground: resolveToken('--vscode-descriptionForeground', '#5d6b81') },
      { token: 'string', foreground: resolveToken('--vscode-debugTokenExpression-string', '#46e08a') },
      { token: 'number', foreground: resolveToken('--vscode-debugTokenExpression-number', '#e0b34a') },
      { token: 'keyword', foreground: resolveToken('--vscode-symbolIcon-keywordForeground', '#5aa2e0') },
      { token: 'type', foreground: resolveToken('--vscode-symbolIcon-classForeground', '#5aa2e0') },
      { token: 'variable', foreground: resolveToken('--vscode-symbolIcon-variableForeground', '#c6cfdc') }
    ],
    colors: {
      'editor.background': bg,
      'editor.foreground': resolveHex('--vscode-editor-foreground', '#c6cfdc'),
      'editor.lineHighlightBackground': resolveHex('--vscode-editor-lineHighlightBackground', '#0c1018'),
      'editor.selectionBackground': resolveHex('--vscode-editor-selectionBackground', '#1d4a3355'),
      'editorLineNumber.foreground': resolveHex('--vscode-editorLineNumber-foreground', '#3a4658'),
      'editorLineNumber.activeForeground': resolveHex('--vscode-editorLineNumber-activeForeground', '#c6cfdc'),
      'editorGutter.background': resolveHex('--vscode-editorGutter-background', bg),
      'editorCursor.foreground': resolveHex('--vscode-editorCursor-foreground', '#46e08a'),
      'editorIndentGuide.background1': resolveHex('--vscode-editorIndentGuide-background1', '#1b2330'),
      'editorWhitespace.foreground': resolveHex('--vscode-editorWhitespace-foreground', '#273246'),
      'editorWidget.background': resolveHex('--vscode-editorWidget-background', '#0c1018'),
      'editorWidget.border': resolveHex('--vscode-editorWidget-border', '#273246'),
      'editorSuggestWidget.background': resolveHex('--vscode-editorSuggestWidget-background', '#0c1018'),
      'editorSuggestWidget.selectedBackground': resolveHex('--vscode-editorSuggestWidget-selectedBackground', '#1d4a33'),
      'editorHoverWidget.background': resolveHex('--vscode-editorHoverWidget-background', '#0c1018'),
      'scrollbarSlider.background': resolveHex('--vscode-scrollbarSlider-background', '#27324699'),
      'scrollbarSlider.hoverBackground': resolveHex('--vscode-scrollbarSlider-hoverBackground', '#273246cc'),
      'scrollbarSlider.activeBackground': resolveHex('--vscode-scrollbarSlider-activeBackground', '#273246')
    }
  });

  monacoRef.editor.setTheme('er-editor');

  if (editor) {
    editor.updateOptions({
      fontFamily: resolveFontFamily('--mono', "'IBM Plex Mono', monospace"),
      fontSize: resolveFontSize('--vscode-editor-font-size', 12.5)
    });
  }
}

function initMonaco() {
  return new Promise(resolve => {
    require.config({ paths: { vs: 'vendor/monaco/vs' } });
    require(['vs/editor/editor.main'], () => {
      monacoRef = window.monaco;
      applyMonacoTheme();
      window.addEventListener('er-theme', applyMonacoTheme);
      editor = monacoRef.editor.create($('#monaco-host'), {
        theme: 'er-editor',
        fontFamily: resolveFontFamily('--mono', "'IBM Plex Mono', monospace"),
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

/* In embed mode a page hosts exactly one panel, but app.js still wires up every
   loop. With five panels open that meant five copies of the 60 Hz screenshot
   poll, each fetching and decoding its own PNG - which is what made the mirror
   stutter. Each page now runs only the loops its own panel needs. In browser
   mode EMBED_PANEL is null and everything runs, as before. */
const EMBED_PANEL = document.body.dataset.embedPanel || null;
const pageNeeds = (...panels) => !EMBED_PANEL || panels.includes(EMBED_PANEL);

const NEEDS_MIRROR = pageNeeds('display', 'metrics');
const NEEDS_ANALYSIS = pageNeeds('metrics');

const canvas = $('#glasses-canvas');
// willReadFrequently forces a software canvas. Only the page that actually
// reads pixels back should pay for that; the mirror itself stays GPU-backed.
const ctx2d = canvas.getContext('2d', NEEDS_ANALYSIS ? { willReadFrequently: true } : undefined);
let prevFrame = null;
let frameTimes = [];
const fetchTimes = [];
let mirrorBusy = false;
let lastAnalysis = 0;

let lastStatsPaint = 0;
let lastFetchStart = 0;

// The metrics page derives FPS and latency from the same fetch, but nobody is
// watching pixels there - four samples a second is plenty.
const MIRROR_MIN_INTERVAL = EMBED_PANEL === 'metrics' ? 250 : 0;

async function mirrorTick() {
  // document.hidden covers a collapsed webview: retainContextWhenHidden keeps
  // the page alive, so without this it would keep polling while invisible.
  if (!state.running || mirrorBusy || document.hidden) return;
  const t0 = performance.now();
  if (t0 - lastFetchStart < MIRROR_MIN_INTERVAL) return;
  lastFetchStart = t0;
  mirrorBusy = true;
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
    const fps = frameTimes.length / 3;
    state.frames++;

    const fetchMs = now - t0;
    fetchTimes.push(fetchMs);
    if (fetchTimes.length > HISTORY_LEN) fetchTimes.shift();

    // Six DOM writes per frame at 60 Hz is a lot of layout for numbers nobody
    // can read that fast. Four times a second is plenty.
    if (now - lastStatsPaint > 250) {
      lastStatsPaint = now;
      $('#lens-fps').textContent = fps.toFixed(1) + ' FPS';
      $('#m-fps').textContent = fps.toFixed(1) + ' fps';
      $('#m-fps-sub').textContent = state.frames.toLocaleString() + ' frames this session';
      $('#m-latency').textContent =
        percentile(fetchTimes, 50).toFixed(0) + ' / ' + percentile(fetchTimes, 95).toFixed(0) + ' ms';
      pushSample('fps', fps);
      pushSample('latency', fetchMs);
    }

    // Pixel analysis reads back 165k pixels. Only the metrics page needs it.
    if (NEEDS_ANALYSIS && now - lastAnalysis > 500) {
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
      const pct = (lit / (576 * 288)) * 100;
      $('#m-lit').textContent = lit.toLocaleString();
      $('#m-lit-pct').textContent = pct.toFixed(1) + '% of 165,888 px framebuffer';
      $('#m-delta').textContent = delta.toLocaleString();
      $('#m-delta-sub').textContent = delta === 0 ? 'static frame' : 'px changed vs previous sample';
      pushSample('lit', pct);
      pushSample('delta', delta);
      paintSparks();

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

// Removing .live only reveals the offline overlay, which is a near-transparent
// hatch - the last frame stays visible through it. The framebuffer is gone the
// moment the simulator is, so clear it rather than leave a dead frame that
// looks live.
function clearMirror() {
  try { ctx2d.clearRect(0, 0, canvas.width, canvas.height); } catch { /* not ready yet */ }
  prevFrame = null;
  frameTimes = [];
  fetchTimes.length = 0;

  const fps = $('#lens-fps');
  if (fps) fps.textContent = '0.0 FPS';
  for (const [sel, value] of [['#m-fps', '—'], ['#m-latency', '—'], ['#m-lit', '—'], ['#m-delta', '—']]) {
    const el = $(sel);
    if (el) el.textContent = value;
  }
  const pct = $('#m-lit-pct');
  if (pct) pct.textContent = 'of 165,888 px framebuffer';
}

// Continuous loop: 15ms tick + busy guard means the next frame is requested
// as soon as the previous one lands - throughput tracks the sim endpoint.
// Paced by the frame clock rather than a fixed 15 ms interval: rAF yields to
// the compositor, pauses on its own when the view is hidden, and cannot queue
// work faster than the page can draw it.
function mirrorLoop() {
  mirrorTick();
  requestAnimationFrame(mirrorLoop);
}
if (NEEDS_MIRROR) requestAnimationFrame(mirrorLoop);

$('#lens').classList.add('glow');

$('#btn-snap').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `g2-frame-${Date.now()}.png`;
  a.click();
});

// Input pad.
//
// Tap actions fire on click. Long press is a hold: the glasses deliver
// LONG_PRESS and LONG_PRESS_RELEASE as two separate events, and an app that
// does anything while the press is held (a progress ring, a hold-to-confirm)
// only behaves correctly if the pad sends them the same way. Sending both
// back-to-back on one click would make every such app look broken.
function sendInput(action) {
  return postJson('/api/sim/input', { action }).catch(err => {
    const message = String((err && err.message) || '');
    // A 4xx here means this simulator build does not know the action - worth
    // saying plainly, since the fix is upgrading the simulator, not retrying.
    toast(/\b4\d\d\b|invalid|unknown/i.test(message)
      ? `Simulator rejected "${action}" - upgrade evenhub-simulator`
      : 'Simulator not reachable - input dropped', true);
  });
}

$$('.pad-btn').forEach(btn => {
  const release = btn.dataset.release;

  if (!release) {
    btn.addEventListener('click', () => sendInput(btn.dataset.action));
    return;
  }

  let held = false;

  const press = event => {
    if (held) return;
    event.preventDefault();
    held = true;
    btn.dataset.held = 'yes';
    sendInput(btn.dataset.action);
  };

  // pointerup can land anywhere - outside the button, outside the window - and
  // a press that is never released leaves the app stuck waiting for one.
  const lift = () => {
    if (!held) return;
    held = false;
    btn.dataset.held = 'no';
    sendInput(release);
  };

  btn.addEventListener('pointerdown', press);
  window.addEventListener('pointerup', lift);
  window.addEventListener('pointercancel', lift);
  window.addEventListener('blur', lift);

  // Keyboard parity: space/enter hold while the key repeats, release on keyup.
  btn.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter') press(e);
  });
  btn.addEventListener('keyup', e => {
    if (e.key === ' ' || e.key === 'Enter') lift();
  });
});

/* ---------------- external links ----------------

   Every DOCS button in this UI is a plain <a target="_blank">. In the desktop
   app that opens a browser tab. Inside VS Code it did nothing at all: the
   panel page is an iframe inside a webview, and a webview iframe cannot open
   a top-level window - the click was swallowed with no error, which is why
   the docs buttons looked dead there.

   So when we are framed, the click is handed up to the host, which opens it
   with vscode.env.openExternal. One handler, delegated, so every link that
   exists now or is added later is covered. */

const FRAMED = window.parent !== window;

document.addEventListener('click', event => {
  const link = event.target.closest && event.target.closest('a[href]');
  if (!link || !FRAMED) return;

  const href = link.getAttribute('href') || '';
  if (!/^https?:\/\//i.test(href)) return;

  event.preventDefault();
  window.parent.postMessage({ type: 'er-open-external', url: link.href }, '*');

  // If nothing up there knows what to do with that - the page is framed by
  // something other than the extension - fall back to opening it ourselves
  // rather than silently eating the click a second time.
  let acked = false;
  const ack = e => { if (e.data && e.data.type === 'er-open-external-ok') acked = true; };
  window.addEventListener('message', ack);
  setTimeout(() => {
    window.removeEventListener('message', ack);
    if (!acked) window.open(link.href, '_blank', 'noopener');
  }, 500);
}, true);

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
if (pageNeeds('glasses-console')) setInterval(consoleTick, 500);

// Tab badges are rebuilt whenever the layout changes, so this is called both
// on new data and on re-render rather than only when a counter moves.
function updateBadges() {
  const console_ = $('#badge-console');
  if (console_) console_.textContent = state.errCount > 0 ? String(state.errCount) : '';

  const proc = $('#badge-process');
  if (proc) proc.textContent = state.procLogCount > 0 ? (state.procLogCount > 99 ? '99+' : String(state.procLogCount)) : '';

  const errors = $('#m-errors');
  if (errors) {
    errors.textContent = String(state.errCount);
    errors.className = 'metric-value mono' + (state.errCount > 0 ? ' metric-bad' : '');
  }
  const warns = $('#m-warns');
  if (warns) warns.textContent = state.warnCount + ' warning' + (state.warnCount === 1 ? '' : 's');
}

/* ---------------- sparklines ----------------
   Deliberately unlabelled and only ~30px tall: the number above is the
   answer, the line is only there to say whether it is settling or drifting. */

function drawSpark(canvas, values, colour) {
  const box = canvas.getBoundingClientRect();
  const width = Math.max(40, Math.round(box.width));
  const height = Math.max(18, Math.round(box.height));
  const dpr = window.devicePixelRatio || 1;

  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (values.length < 2) return;

  const max = Math.max(...values, 0.0001);
  const min = Math.min(...values, 0);
  const span = (max - min) || 1;
  const step = width / (HISTORY_LEN - 1);
  const offset = width - (values.length - 1) * step;   // newest sample on the right

  ctx.beginPath();
  values.forEach((v, i) => {
    const x = offset + i * step;
    const y = height - 1 - ((v - min) / span) * (height - 2);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.lineTo(offset + (values.length - 1) * step, height);
  ctx.lineTo(offset, height);
  ctx.closePath();
  // globalAlpha rather than rewriting the colour string: a theme token can
  // resolve to a hex, an rgb() or an rgba(), and only one of those survives
  // being patched by hand.
  ctx.globalAlpha = 0.13;
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.globalAlpha = 1;
}

/* Read once per paint so a theme switch shows up on the next sample without
   any explicit invalidation. */
const SPARK_TOKENS = {
  fps: ['--ok', 'rgb(70, 224, 138)'],
  latency: ['--warn', 'rgb(224, 179, 74)'],
  lit: ['--info', 'rgb(90, 162, 224)'],
  delta: ['--info', 'rgb(90, 162, 224)'],
  rss: ['--muted', 'rgb(93, 107, 129)']
};

const SPARK_COLOURS = new Proxy({}, {
  get(_, key) {
    const spec = SPARK_TOKENS[key];
    return spec ? resolveColour(spec[0], spec[1]) : undefined;
  }
});

function paintSparks() {
  for (const canvas of $$('.spark')) {
    const series = canvas.dataset.spark;
    if (!history[series]) continue;
    try { drawSpark(canvas, history[series], SPARK_COLOURS[series] || 'rgb(120,140,160)'); }
    catch { /* zero-size canvas while the panel is hidden */ }
  }
}

window.addEventListener('er-theme', paintSparks);

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

  state.procLines = (state.procLines || 0) + 1;
  const total = $('#m-proclines');
  if (total) total.textContent = state.procLines.toLocaleString();

  const panel = $('#dock-process');
  if (!panel || !panel.classList.contains('active')) {
    state.procLogCount++;
    updateBadges();
  }
}

/* ---------------- dock ---------------- */

/* ---------------- panels ----------------
   panels.js owns where each panel lives and which one is on top; it announces
   what it did and this reacts. CLEAR is no longer a single dock-wide button
   that had to guess what the active tab was: each panel that can be cleared
   carries its own, so on METRICS, DOCTOR and REFERENCE the action simply does
   not exist. */

function clearPanel(which) {
  if (which === 'terminal' && term) term.clear();

  if (which === 'process') {
    $('#process-log').innerHTML = '';
    state.procLines = 0;
    state.procLogCount = 0;
    const total = $('#m-proclines');
    if (total) total.textContent = '0';
    updateBadges();
  }

  if (which === 'glasses-console') {
    $('#glasses-log').innerHTML = '';
    api('/api/sim/console', { method: 'DELETE' }).catch(() => {});
    state.errCount = 0;
    state.warnCount = 0;
    updateBadges();
  }
}

// Bound once, while every panel is still in this document. The listeners ride
// along with the node when a panel is torn off into its own window.
$$('.panel-clear').forEach(btn => {
  btn.addEventListener('click', () => clearPanel(btn.dataset.clear));
});

window.addEventListener('panel:activate', ev => {
  const id = ev.detail.panel;
  if (id === 'process') { state.procLogCount = 0; updateBadges(); }
  if (id === 'terminal' && fitAddon) setTimeout(() => { try { fitAddon.fit(); } catch { /* not laid out yet */ } }, 0);
  // Opening the panel is itself a request for a report.
  if (id === 'doctor' && !doctorReport && !state.doctorBusy) runDoctor();
  if (id === 'metrics') paintSparks();
});

window.addEventListener('panel:moved', ev => {
  const id = ev.detail.panel;

  if (id === 'terminal') {
    // xterm measures against the document it is in, so it needs a beat and a
    // refit after crossing into (or out of) a panel window.
    setTimeout(() => {
      try {
        if (fitAddon) fitAddon.fit();
        if (term) term.refresh(0, term.rows - 1);
      } catch { /* mid-move */ }
    }, 40);
  }

  if (id === 'webview') {
    // Moving an iframe between documents tears down its browsing context, so
    // the src has to be set again or the panel comes back blank.
    const frame = $('#webview');
    if (frame && state.viteUrl) frame.src = state.viteUrl;
  }

  if (id === 'metrics') setTimeout(paintSparks, 40);
});

// Tabs are rebuilt whenever the layout changes, and the badges live on them.
window.addEventListener('panels:rendered', () => {
  updateBadges();
  if (doctorReport) paintDoctorSummary();
});

const resetMetrics = $('#btn-metrics-reset');
if (resetMetrics) {
  resetMetrics.addEventListener('click', () => {
    resetHistory();
    fetchTimes.length = 0;
    state.frames = 0;
    state.procLines = 0;
    const total = $('#m-proclines');
    if (total) total.textContent = '0';
    toast('Metrics history cleared');
  });
}

/* ---------------- terminal ---------------- */

/* xterm gets the workbench's own terminal palette, all sixteen ANSI slots
   included - so `ls` in this terminal is coloured exactly like `ls` in the
   integrated terminal one panel over. */
function terminalTheme() {
  const ansi = (name, fallback) => resolveHex('--vscode-terminal-ansi' + name, fallback);
  return {
    background: resolveHex('--vscode-terminal-background', resolveHex('--panel', '#0c1018')),
    foreground: resolveHex('--vscode-terminal-foreground', resolveHex('--text', '#c6cfdc')),
    cursor: resolveHex('--vscode-terminalCursor-foreground', resolveHex('--focus', '#46e08a')),
    cursorAccent: resolveHex('--vscode-terminalCursor-background', resolveHex('--panel', '#0c1018')),
    selectionBackground: resolveHex('--vscode-terminal-selectionBackground', '#1d4a3388'),
    black: ansi('Black', '#0c1018'),
    red: ansi('Red', '#e05555'),
    green: ansi('Green', '#46e08a'),
    yellow: ansi('Yellow', '#e0b34a'),
    blue: ansi('Blue', '#5aa2e0'),
    magenta: ansi('Magenta', '#a98ae0'),
    cyan: ansi('Cyan', '#4ec9c9'),
    white: ansi('White', '#c6cfdc'),
    brightBlack: ansi('BrightBlack', '#5d6b81'),
    brightRed: ansi('BrightRed', '#ff6b6b'),
    brightGreen: ansi('BrightGreen', '#6df0a5'),
    brightYellow: ansi('BrightYellow', '#f0c96a'),
    brightBlue: ansi('BrightBlue', '#7fbcf0'),
    brightMagenta: ansi('BrightMagenta', '#c3a6f5'),
    brightCyan: ansi('BrightCyan', '#6fe0e0'),
    brightWhite: ansi('BrightWhite', '#e6ecf4')
  };
}

function initTerminal() {
  term = new Terminal({
    fontFamily: resolveFontFamily('--mono', "'IBM Plex Mono', monospace"),
    fontSize: 12,
    theme: terminalTheme(),
    cursorBlink: true
  });

  window.addEventListener('er-theme', () => {
    if (!term) return;
    term.options.theme = terminalTheme();
    term.options.fontFamily = resolveFontFamily('--mono', "'IBM Plex Mono', monospace");
    try { if (fitAddon) fitAddon.fit(); } catch { /* not laid out */ }
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
  window.addEventListener('resize', () => {
    try { fitAddon.fit(); } catch { /* not laid out */ }
    paintSparks();
  });
}

/* ---------------- metrics timers ---------------- */

if (pageNeeds('metrics')) setInterval(() => {
  const uptime = $('#m-uptime');
  const sub = $('#m-uptime-sub');
  if (!uptime) return;

  if (state.running && state.startedAt) {
    const s = Math.floor((Date.now() - state.startedAt) / 1000);
    const h = Math.floor(s / 3600);
    const body = `${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    uptime.textContent = h ? `${h}:${body}` : body;
    if (sub) sub.textContent = 'session running';
  } else {
    uptime.textContent = '\u2014';
    if (sub) sub.textContent = 'not running';
  }
}, 1000);

if (pageNeeds('metrics')) setInterval(async () => {
  try {
    const h = await api('/api/metrics/host');

    const rss = $('#m-host');
    if (rss) rss.textContent = h.rssMb + ' MB';
    const rssSub = $('#m-host-sub');
    if (rssSub && h.heapMb != null) rssSub.textContent = `${h.heapMb} MB heap in use`;
    pushSample('rss', h.rssMb);

    const cpu = $('#m-cpu');
    if (cpu && h.cpuPct != null) cpu.textContent = h.cpuPct.toFixed(1) + '%';
    const cpuSub = $('#m-cpu-sub');
    if (cpuSub && h.loadAvg1 != null) cpuSub.textContent = `load ${h.loadAvg1} across ${h.cpuCount} cores`;

    paintSparks();
  } catch { /* server unreachable - the status bar already says so */ }
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


/* ---------------- resizable panels ---------------- */

function initSplitters() {
  const root = document.documentElement;

  // restore saved layout
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('er-layout') || '{}'); } catch { saved = {}; }
  for (const [k, v] of Object.entries(saved)) root.style.setProperty(k, v);

  function persist(cssVar, value) {
    let store = {};
    try { store = JSON.parse(localStorage.getItem('er-layout') || '{}'); } catch { store = {}; }
    if (value === null) delete store[cssVar];
    else store[cssVar] = value;
    localStorage.setItem('er-layout', JSON.stringify(store));
  }

  function makeSplitter(el, cssVar, opts) {
    if (!el) return; // markup missing - never break boot over a splitter

    el.addEventListener('pointerdown', ev => {
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      el.classList.add('dragging');
      const startPos = opts.horizontal ? ev.clientY : ev.clientX;
      const current = parseFloat(getComputedStyle(root).getPropertyValue(cssVar));
      const startVal = Number.isFinite(current) ? current : opts.fallback;

      const onMove = e => {
        const pos = opts.horizontal ? e.clientY : e.clientX;
        let val = startVal + (pos - startPos) * (opts.invert ? -1 : 1);
        val = Math.max(opts.min, Math.min(opts.max, val));
        root.style.setProperty(cssVar, val + 'px');
        if (fitAddon) fitAddon.fit(); // keep xterm cols/rows in sync while dragging
      };
      const onUp = () => {
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        persist(cssVar, getComputedStyle(root).getPropertyValue(cssVar).trim());
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
    });

    // double-click a splitter = reset that panel to its default size
    el.addEventListener('dblclick', () => {
      root.style.removeProperty(cssVar);
      persist(cssVar, null);
      if (fitAddon) fitAddon.fit();
    });
  }

  makeSplitter($('#split-sidebar'), '--sidebar-w', { min: 160, max: 520, fallback: 236 });
  makeSplitter($('#split-devices'), '--devices-w', { min: 280, max: 720, fallback: 404, invert: true });
  makeSplitter($('#split-dock'),    '--dock-h',    { min: 120, max: 600, fallback: 262, invert: true, horizontal: true });
}

/* ---------------- boot ---------------- */

(async function boot() {
  if (navigator.userAgent.includes('Electron')) document.body.classList.add('electron');
  connectWs();
  try { initSplitters(); } catch (e) { console.error('splitters:', e); }
  try { initTerminal(); } catch (e) { toast('Terminal init failed: ' + e.message, true); }
  try { await initMonaco(); } catch (e) { toast('Editor init failed: ' + e.message, true); }
  try {
    await loadProjects();
    await loadTree();
  } catch (e) { toast(e.message, true); }
  refreshSdk();

  // First-launch diagnostics: quiet when everything is fine, a badge and one
  // toast when it is not. Never a modal - it must not get in the way.
  $('#doctor-autorun').checked = doctorAutorunEnabled();
  if (doctorAutorunEnabled()) {
    runDoctor().then(report => {
      if (report && report.summary.fail > 0) {
        toast(`${report.summary.fail} environment problem${report.summary.fail === 1 ? '' : 's'} found - see DOCTOR`, true);
      }
    }).catch(() => {});
  }
  
})();