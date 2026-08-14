// Owns the single ER Studio server instance behind the extension.
//
// The server is started lazily and shared by every view and command, so
// opening five panels does not start five servers. Callers await ensure()
// and get back the same handle each time.

const fs = require('fs');
const path = require('path');
const os = require('os');
const vscode = require('vscode');

// Core is loaded from one of two places, in this order:
//
//   ./core       vendored by scripts/prepare-vscode-package.js, which is what
//                ships inside the .vsix
//   @er-studio/core   the workspace symlink, which is what exists when you
//                     press F5 in the monorepo
//
// Neither is a fallback for a broken install - they are the packaged layout
// and the development layout, and both are normal.
function loadCore() {
  try {
    return require('../core');
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
    return require('@er-studio/core');
  }
}

const { startServer } = loadCore();

// The same file the core server reads. Honouring it here keeps the extension
// and the doctor pointed at one folder.
function readUserConfigWorkspace() {
  try {
    const file = path.join(os.homedir(), '.er-studio.json');
    if (!fs.existsSync(file)) return null;
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cfg.workspace ? path.resolve(cfg.workspace) : null;
  } catch {
    return null;
  }
}

// The open folder counts as a workspace only if it already looks like one:
// a subfolder with a package.json. Otherwise ER Studio would quietly adopt
// whatever happened to be open.
function openFolderWithProjects() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0 || folders[0].uri.scheme !== 'file') return null;

  const root = folders[0].uri.fsPath;
  try {
    const hasProject = fs
      .readdirSync(root, { withFileTypes: true })
      .some(e => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'package.json')));
    return hasProject ? root : null;
  } catch {
    return null;
  }
}

class ServerHost {
  constructor(output) {
    this.output = output;
    this.handle = null;
    this.starting = null;
    this.listeners = new Set();
    this.state = { simAlive: false, viteAlive: false };
  }

  get port() {
    return this.handle ? this.handle.port : null;
  }

  get origin() {
    return this.handle ? `http://127.0.0.1:${this.handle.port}` : null;
  }

  // The folder the server actually settled on, which is what the doctor
  // reports and where projects are created. Prefer this over re-deriving it.
  get workspace() {
    return this.handle ? this.handle.workspace : this.resolveWorkspace();
  }

  // Where the Even Hub projects live.
  //
  // Precedence matters here: passing a workspace to startServer OVERRIDES
  // ~/.er-studio.json, so guessing means the server and the doctor disagree
  // about which folder is in use - the doctor reads the config file, the
  // server used the guess. So the extension only passes a path when the user
  // has actually chosen one.
  //
  //   1. erStudio.workspace        - chosen explicitly, or during setup
  //   2. ~/.er-studio.json         - an existing ER Studio config (server reads it)
  //   3. the open folder           - only if it already contains projects
  //   4. nothing                   - the server decides, and setup asks
  resolveWorkspace() {
    const configured = vscode.workspace.getConfiguration('erStudio').get('workspace');
    if (configured) return path.resolve(configured);

    const fromConfig = readUserConfigWorkspace();
    if (fromConfig) return fromConfig;

    const folder = openFolderWithProjects();
    if (folder) return folder;

    return path.join(os.homedir(), 'er-workspace');
  }

  // True when the path above came from the user rather than a fallback, which
  // is what setup uses to decide whether it still needs to ask.
  hasChosenWorkspace() {
    return (
      !!vscode.workspace.getConfiguration('erStudio').get('workspace') ||
      !!readUserConfigWorkspace()
    );
  }

  async ensure() {
    if (this.handle) return this.handle;
    if (this.starting) return this.starting;

    const chosen = this.hasChosenWorkspace() ? this.resolveWorkspace() : null;
    const port = vscode.workspace.getConfiguration('erStudio').get('port') || 0;

    this.output.appendLine(
      `[er-studio] starting server  workspace=${chosen || '(from ~/.er-studio.json or default)'}  port=${port || 'auto'}`
    );

    this.starting = startServer(
      chosen ? { port, workspace: chosen, host: 'vscode' } : { port, host: 'vscode' }
    )
      .then(handle => {
        this.handle = handle;
        this.starting = null;
        this.output.appendLine(`[er-studio] server listening on http://127.0.0.1:${handle.port}`);
        this.output.appendLine(`[er-studio] workspace in use: ${handle.workspace}`);
        if (!handle.hasPty) {
          this.output.appendLine('[er-studio] node-pty unavailable - the TERMINAL panel falls back to a command runner (VS Code\'s own terminal is unaffected)');
        }

        handle.events.on('event', msg => {
          if (msg.type === 'status') this.state = msg.state;
          for (const fn of this.listeners) {
            try { fn(msg); } catch { /* a bad listener must not stop the others */ }
          }
        });

        return handle;
      })
      .catch(err => {
        this.starting = null;
        this.output.appendLine(`[er-studio] server failed to start: ${err.stack || err.message}`);
        throw err;
      });

    return this.starting;
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  async api(pathname, init) {
    const handle = await this.ensure();
    const res = await fetch(`http://127.0.0.1:${handle.port}${pathname}`, {
      headers: { 'content-type': 'application/json' },
      ...init
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
    return body;
  }

  post(pathname, payload) {
    return this.api(pathname, { method: 'POST', body: JSON.stringify(payload || {}) });
  }

  async restart() {
    this.dispose();
    return this.ensure();
  }

  dispose() {
    if (this.handle) {
      try { this.handle.close(); } catch { /* already gone */ }
      this.output.appendLine('[er-studio] server stopped');
    }
    this.handle = null;
    this.starting = null;
  }
}

module.exports = { ServerHost };
