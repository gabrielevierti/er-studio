#!/usr/bin/env node
// ER Studio - Even Realities Studio
// Local development console for Even G2 (Even Hub) apps.
// Runs standalone (`node server/index.js`) or embedded by the Electron shell.
// Binds to 127.0.0.1 only.

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { EventEmitter } = require('events');
const express = require('express');
const { WebSocketServer } = require('ws');

const { createFilesRouter } = require('./files');
const { createProcessManager, SIM_AUTOMATION_PORT } = require('./proc');
const { createSimRouter } = require('./sim');
const { attachTerminal, hasPty } = require('./term');
const { createSdkRouter } = require('./sdk');
const { createDoctorRouter } = require('./doctor');

// Optional user config: ~/.er-studio.json  { "workspace": "...", "port": 4477 }
function readUserConfig() {
  try {
    const p = path.join(os.homedir(), '.er-studio.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error('[er-studio] could not read ~/.er-studio.json:', err.message);
  }
  return {};
}

async function startServer(options = {}) {
  const cfg = readUserConfig();
  const requestedPort = options.port ?? cfg.port ?? 4477;
  const workspace = path.resolve(
    options.workspace || cfg.workspace || path.join(os.homedir(), 'er-workspace')
  );
  if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });

  const events = new EventEmitter();

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set();

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
    events.emit('event', msg);
  }

  const procman = createProcessManager(workspace, broadcast);

  // Watch the workspace so the explorer refreshes itself (scaffolds, terminal
  // work, external editors). Debounced; noisy dirs ignored.
  try {
    const IGNORE_WATCH = /(^|\/)(node_modules|\.git|dist|out|\.apps-cache)(\/|$)/;
    let watchTimer = null;
    fs.watch(workspace, { recursive: true }, (evt, filename) => {
      if (filename && IGNORE_WATCH.test(filename)) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => broadcast({ type: 'fs-changed' }), 400);
    });
  } catch (err) {
    console.error('[er-studio] fs watcher unavailable:', err.message);
  }

  wss.on('connection', ws => {
    clients.add(ws);
    const send = msg => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
    send({ type: 'hello', workspace, hasPty, state: procman.publicState() });

    const term = attachTerminal(ws, workspace, send);

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'term-input') term.write(msg.data);
      else if (msg.type === 'term-resize') term.resize(msg.cols, msg.rows);
    });

    ws.on('close', () => {
      clients.delete(ws);
      term.dispose();
    });
  });

  app.get('/api/version', (req, res) => {
    const packageJson = require('../package.json');
    res.json({ version: packageJson.version });
  });

  app.use('/api/fs', createFilesRouter(workspace));
  app.use('/api/sim', createSimRouter(SIM_AUTOMATION_PORT));
  app.use('/api/sdk', createSdkRouter(workspace));
  app.use('/api/doctor', createDoctorRouter({
    workspace,
    hasPty,
    procman,
    simAutomationPort: SIM_AUTOMATION_PORT,
    appVersion: require('../package.json').version
  }));

  app.get('/api/state', (req, res) => {
    res.json({ workspace, hasPty, state: procman.publicState() });
  });

  app.post('/api/run/start', (req, res) => {
    const r = procman.start((req.body || {}).project);
    res.status(r.error ? 400 : 200).json(r);
  });

  app.post('/api/run/stop', (req, res) => {
    res.json(procman.stop());
  });

  app.post('/api/run/restart', async (req, res) => {
    const r = await procman.restart((req.body || {}).project);
    res.status(r.error ? 400 : 200).json(r);
  });

  app.post('/api/job/pack', (req, res) => {
    const r = procman.pack((req.body || {}).project);
    res.status(r.error ? 400 : 200).json(r);
  });

  app.post('/api/job/scaffold', (req, res) => {
    const { name, template } = req.body || {};
    const r = procman.scaffold(name, template);
    res.status(r.error ? 400 : 200).json(r);
  });

  app.get('/api/metrics/host', (req, res) => {
    const mem = process.memoryUsage();
    res.json({ rssMb: +(mem.rss / 1048576).toFixed(1), uptimeS: Math.round(process.uptime()) });
  });

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', () => resolve(server.address().port));
  });

  return { port, workspace, hasPty, events, procman, close: () => { procman.shutdown(); server.close(); } };
}

module.exports = { startServer };

// ---- CLI entry (browser mode) ----
if (require.main === module) {
  process.on('uncaughtException', err => {
    console.error('[er-studio] uncaught exception (server kept alive):', err.stack || err);
  });
  process.on('unhandledRejection', err => {
    console.error('[er-studio] unhandled rejection (server kept alive):', (err && err.stack) || err);
  });

  const args = process.argv.slice(2);
  const argValue = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };

  startServer({
    port: parseInt(argValue('--port', ''), 10) || undefined,
    workspace: argValue('--workspace', undefined)
  }).then(({ port, workspace, hasPty: ptyOk, procman }) => {
    const shutdown = () => { procman.shutdown(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    console.log('');
    console.log('  ER STUDIO - Even Realities development console');
    console.log(`  UI         http://127.0.0.1:${port}`);
    console.log(`  Workspace  ${workspace}`);
    console.log(`  Terminal   ${ptyOk ? 'pty (interactive shell)' : 'fallback command runner'}`);
    console.log('');
  }).catch(err => {
    console.error('[er-studio] failed to start:', err.message);
    process.exit(1);
  });
}
