// ER Studio - managed processes
// Owns the Vite dev server and the Even Hub simulator as child process groups,
// plus one-shot jobs (build+pack, scaffold). All stdout/stderr is broadcast to
// the UI over the websocket as { type:'proclog', source, line }.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SIM_AUTOMATION_PORT = 9898;

function createProcessManager(workspaceRoot, broadcast) {
  const state = {
    running: false,
    project: null,
    vitePort: null,
    viteUrl: null,
    simAutomationPort: SIM_AUTOMATION_PORT,
    startedAt: null,
    simStartedAt: null,
    job: null // { kind, project, startedAt }
  };

  let viteProc = null;
  let simProc = null;
  let jobProc = null;

  function emitStatus() {
    broadcast({ type: 'status', state: publicState() });
  }

  function publicState() {
    return {
      running: state.running,
      project: state.project,
      vitePort: state.vitePort,
      viteUrl: state.viteUrl,
      simAutomationPort: state.simAutomationPort,
      startedAt: state.startedAt,
      simStartedAt: state.simStartedAt,
      viteAlive: !!viteProc,
      simAlive: !!simProc,
      job: state.job
    };
  }

  // Vite colorizes output even without a TTY; escape codes land inside the
  // URL (http://localhost:\x1b[1m5173) and break both matching and reading.
  const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;
  const stripAnsi = s => s.replace(ANSI_RE, '');

  function log(source, chunk) {
    const text = stripAnsi(chunk.toString('utf8'));
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      broadcast({ type: 'proclog', source, line, ts: Date.now() });
    }
  }

  function spawnGroup(cmd, args, cwd, source, env) {
    const child = spawn(cmd, args, {
      cwd,
      detached: true, // own process group so we can kill the whole tree
      env: { ...process.env, ...env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', d => log(source, d));
    child.stderr.on('data', d => log(source, d));
    child.on('error', err => log(source, Buffer.from(`[er-studio] spawn error: ${err.message}`)));
    return child;
  }

  function killGroup(child) {
    if (!child || child.killed) return;
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
  }

  function projectDir(project) {
    const abs = path.resolve(workspaceRoot, project);
    const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
    if (!abs.startsWith(rootWithSep)) return null;
    if (!fs.existsSync(path.join(abs, 'package.json'))) return null;
    return abs;
  }

  function startSim(targetUrl) {
    state.simStartedAt = Date.now();
    // Global install first, npx fallback keeps first run friction-free.
    const simCmd = `command -v evenhub-simulator >/dev/null 2>&1 && exec evenhub-simulator "$TARGET_URL" --automation-port ${SIM_AUTOMATION_PORT} || exec npx -y @evenrealities/evenhub-simulator "$TARGET_URL" --automation-port ${SIM_AUTOMATION_PORT}`;
    simProc = spawnGroup('/bin/sh', ['-c', simCmd], workspaceRoot, 'sim', { TARGET_URL: targetUrl });
    simProc.on('exit', code => {
      log('sim', Buffer.from(`[er-studio] simulator exited (code ${code})`));
      simProc = null;
      emitStatus();
    });
    emitStatus();
  }

  function start(project) {
    if (state.running) return { error: 'Session already running' };
    const cwd = projectDir(project);
    if (!cwd) return { error: `Project "${project}" not found in workspace (needs package.json)` };

    state.running = true;
    state.project = project;
    state.vitePort = null;
    state.viteUrl = null;
    state.startedAt = Date.now();
    state.simStartedAt = null;

    viteProc = spawnGroup('npm', ['run', 'dev'], cwd, 'vite');
    let simLaunched = false;

    const portWatcher = chunk => {
      if (simLaunched) return;
      const text = stripAnsi(chunk.toString('utf8'));
      const m = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (m) {
        state.vitePort = parseInt(m[1], 10);
        state.viteUrl = `http://localhost:${state.vitePort}`;
        simLaunched = true;
        log('vite', Buffer.from(`[er-studio] dev server detected on ${state.viteUrl} - launching simulator`));
        startSim(state.viteUrl);
      }
    };
    viteProc.stdout.on('data', portWatcher);
    viteProc.stderr.on('data', portWatcher);

    viteProc.on('exit', code => {
      log('vite', Buffer.from(`[er-studio] dev server exited (code ${code})`));
      viteProc = null;
      emitStatus();
    });

    emitStatus();
    return { ok: true, state: publicState() };
  }

  function stop() {
    killGroup(simProc);
    killGroup(viteProc);
    simProc = null;
    viteProc = null;
    state.running = false;
    state.vitePort = null;
    state.viteUrl = null;
    state.startedAt = null;
    state.simStartedAt = null;
    emitStatus();
    return { ok: true };
  }

  async function restart(project) {
    stop();
    await new Promise(r => setTimeout(r, 800)); // let ports free up
    return start(project);
  }

  // One-shot job: npm run build, then evenhub-cli pack app.json dist
  function pack(project) {
    if (state.job) return { error: 'Another job is already running' };
    const cwd = projectDir(project);
    if (!cwd) return { error: `Project "${project}" not found` };
    if (!fs.existsSync(path.join(cwd, 'app.json'))) {
      return { error: 'app.json manifest not found in project root - required by evenhub-cli pack' };
    }
    state.job = { kind: 'pack', project, startedAt: Date.now() };
    const cmd = 'npm run build && { command -v evenhub-cli >/dev/null 2>&1 && evenhub-cli pack app.json dist || npx -y @evenrealities/evenhub-cli pack app.json dist; }';
    jobProc = spawnGroup('/bin/sh', ['-c', cmd], cwd, 'job');
    jobProc.on('exit', code => {
      log('job', Buffer.from(`[er-studio] pack ${code === 0 ? 'completed' : 'failed'} (code ${code})`));
      broadcast({ type: 'job-done', kind: 'pack', code });
      state.job = null;
      jobProc = null;
      emitStatus();
    });
    emitStatus();
    return { ok: true };
  }

  // One-shot job: scaffold from official templates, then npm install
  function scaffold(name, template) {
    if (state.job) return { error: 'Another job is already running' };
    if (!/^[a-zA-Z0-9._-]+$/.test(name || '')) return { error: 'Project name: letters, digits, ".", "_", "-" only' };
    const allowed = new Set(['minimal', 'asr', 'image', 'text-heavy']);
    if (!allowed.has(template)) return { error: 'Unknown template' };
    const dest = path.join(workspaceRoot, name);
    if (fs.existsSync(dest)) return { error: 'A project with that name already exists' };
    state.job = { kind: 'scaffold', project: name, startedAt: Date.now() };
    const cmd = `npx -y degit "even-realities/evenhub-templates/${template}" "$DEST" && cd "$DEST" && npm install`;
    jobProc = spawnGroup('/bin/sh', ['-c', cmd], workspaceRoot, 'job', { DEST: dest });
    jobProc.on('exit', code => {
      log('job', Buffer.from(`[er-studio] scaffold ${code === 0 ? 'completed' : 'failed'} (code ${code})`));
      broadcast({ type: 'job-done', kind: 'scaffold', code, project: name });
      state.job = null;
      jobProc = null;
      emitStatus();
    });
    emitStatus();
    return { ok: true };
  }


  // One-shot job: run a batch of doctor fix commands, in order.
  //
  // Only commands a check explicitly marked `auto: true` ever get here - the
  // route filters against the live doctor report, so the UI cannot post
  // arbitrary shell. Sequential rather than parallel because npm will happily
  // corrupt a tree if two installs touch it at once.
  //
  // A failing command does not abort the batch: a global install failing has
  // no bearing on a project install, and the doctor re-run afterwards reports
  // the real state anyway.
  function runFixes(commands) {
    if (state.job) return { error: 'Another job is already running' };
    if (!Array.isArray(commands) || commands.length === 0) return { error: 'No fixes to run' };

    state.job = { kind: 'fixes', project: state.project, startedAt: Date.now(), total: commands.length };
    emitStatus();

    let index = 0;
    const results = [];

    const runNext = () => {
      if (index >= commands.length) {
        const failed = results.filter(r => r.code !== 0).length;
        log('job', Buffer.from(`[er-studio] fixes complete - ${results.length - failed}/${results.length} succeeded`));
        broadcast({ type: 'job-done', kind: 'fixes', code: failed === 0 ? 0 : 1, results });
        state.job = null;
        jobProc = null;
        emitStatus();
        return;
      }

      const cmd = commands[index++];
      log('job', Buffer.from(`[er-studio] fix ${index}/${commands.length}: ${cmd}`));
      jobProc = spawnGroup('/bin/sh', ['-c', cmd], workspaceRoot, 'job');
      jobProc.on('exit', code => {
        results.push({ command: cmd, code });
        log('job', Buffer.from(`[er-studio] ${code === 0 ? 'ok' : `failed (code ${code})`}`));
        broadcast({ type: 'fix-progress', done: index, total: commands.length, command: cmd, code });
        runNext();
      });
    };

    runNext();
    return { ok: true, total: commands.length };
  }

  function shutdown() {
    killGroup(jobProc);
    stop();
  }

  return { start, stop, restart, pack, scaffold, runFixes, publicState, shutdown };
}

module.exports = { createProcessManager, SIM_AUTOMATION_PORT };
