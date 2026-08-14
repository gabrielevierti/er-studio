// ER Studio for VS Code
//
// The extension is deliberately thin. It supplies what a host is supposed to
// supply - activity bar container, views, commands, keybindings, status bar,
// settings, diagnostics - and delegates everything else to @er-studio/core,
// which is the same code the desktop app runs.
//
// What the desktop app does that this does not, on purpose: the editor, the
// file tree, the terminal and panel tear-off. VS Code already does all four
// better than a bespoke shell can, so porting them would have made the
// product worse.

const path = require('path');
const vscode = require('vscode');

const { ServerHost } = require('./server-host');
const { PanelViewProvider } = require('./panel-view');
const { DoctorDiagnostics } = require('./diagnostics');
const { prepareWorkspace } = require('./onboarding');
const { EditorPanels } = require('./editor-panels');
const { ControlsView } = require('./controls-view');
const { ProjectExplorer } = require('./project-explorer');

// view id -> ER Studio panel id. Simulator and Webview are not here: they are
// editor tabs (see editor-panels.js), because a 576x288 mirror and a browser
// pane belong beside your code rather than in a sidebar strip.
const VIEWS = {
  'erStudio.console': 'process',
  'erStudio.simConsole': 'glasses-console',
  'erStudio.sdkref': 'sdkref',
  'erStudio.doctor': 'doctor',
  'erStudio.metrics': 'metrics'
};

// Mirrors the template cards in the desktop app's NEW PROJECT dialog. These
// are the official Even Hub templates degit pulls from.
const TEMPLATES = [
  { id: 'minimal', blurb: 'Bare scaffold, single page' },
  { id: 'asr', blurb: 'Speech recognition (mic stream)' },
  { id: 'image', blurb: 'Image rendering pipeline' },
  { id: 'text-heavy', blurb: 'Paging / long text UI' }
];

const PROJECT_KEY = 'erStudio.activeProject';

let server = null;
let output = null;
let editors = null;
let controls = null;
let explorer = null;
let statusItem = null;
let projectItem = null;
let doctor = null;
let memento = null;
const providers = new Map();

function activate(context) {
  memento = context.workspaceState;

  output = vscode.window.createOutputChannel('ER Studio');
  context.subscriptions.push(output);

  server = new ServerHost(output);
  context.subscriptions.push({ dispose: () => server.dispose() });

  doctor = new DoctorDiagnostics().register(context);

  editors = new EditorPanels(server, output);
  context.subscriptions.push({ dispose: () => editors.dispose() });

  explorer = new ProjectExplorer(server).register(context);

  controls = new ControlsView({
    server,
    getState: () => ({ running: !!server.state.simAlive, project: memento.get(PROJECT_KEY) }),
    arrange: () => arrangeLayout()
  }).register(context);

  for (const [viewId, panelId] of Object.entries(VIEWS)) {
    const provider = new PanelViewProvider(server, panelId);
    providers.set(viewId, provider);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(viewId, provider, {
        // Panels keep their scrollback and canvas contents when the view is
        // collapsed, which matters most for the two consoles.
        webviewOptions: { retainContextWhenHidden: true }
      })
    );
  }

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'erStudio.doctor';
  statusItem.text = '$(circle-slash) ER Studio';
  statusItem.tooltip = 'ER Studio - starting';
  statusItem.show();

  projectItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  projectItem.command = 'erStudio.selectProject';
  projectItem.tooltip = 'ER Studio - active project (click to change)';
  context.subscriptions.push(statusItem, projectItem);

  registerCommands(context);

  // Keep the status bar and the run/stop buttons in step with the session.
  context.subscriptions.push(
    server.onEvent(msg => {
      if (msg.type === 'status') {
        vscode.commands.executeCommand('setContext', 'erStudio.running', !!msg.state.simAlive);
        refreshStatus();
        if (controls) controls.refresh();
        broadcastSessionState();
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('erStudio.workspace') || e.affectsConfiguration('erStudio.port')) {
        vscode.window
          .showInformationMessage('ER Studio settings changed. Restart the local server to apply them?', 'Restart')
          .then(choice => {
            if (choice === 'Restart') vscode.commands.executeCommand('erStudio.restartServer');
          });
      }
    })
  );

  // Panels are themed by the core stylesheet; tell them which way round the
  // host currently is so they are not a dark rectangle in a light theme.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      for (const provider of providers.values()) provider.refreshTheme();
    })
  );

  refreshProjectItem();
  trackCursor(context);

  if (vscode.workspace.getConfiguration('erStudio').get('autoStart')) {
    server
      .ensure()
      .then(async () => {
        await refreshStatus();
        if (explorer) explorer.refresh();

        // Leaves a project open and the panels populated, so the tab is ready
        // to work in rather than ready to be configured.
        await prepareWorkspace({
          server,
          output,
          state: memento,
          onProjectReady: name => {
            memento.update(PROJECT_KEY, name);
            refreshProjectItem();
            if (controls) controls.refresh();
            if (explorer) explorer.refresh();
            broadcastSessionState();
          },
          // A chosen folder only takes effect once the server restarts with it.
          onWorkspaceChanged: async () => {
            await server.restart();
            output.appendLine(`[er-studio] restarted on ${server.workspace}`);
          }
        }).catch(err => output.appendLine(`[er-studio] setup: ${err.message}`));

        if (vscode.workspace.getConfiguration('erStudio').get('doctorOnStartup')) {
          await runDoctor({ quiet: true });
        }
      })
      .catch(() => {
        statusItem.text = '$(error) ER Studio';
        statusItem.tooltip = 'ER Studio failed to start - see the ER Studio output channel';
      });
  }
}

function registerCommands(context) {
  const guard = (name, fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      output.appendLine(`[er-studio] ${name} failed: ${err.stack || err.message}`);
      vscode.window.showErrorMessage(`ER Studio: ${err.message}`);
    }
  };

  const input = action =>
    guard(`input ${action}`, async () => {
      await server.post('/api/sim/input', { action });
    });

  const commands = {
    'erStudio.run': guard('run', async () => {
      const project = await activeProject({ prompt: true });
      await server.post('/api/run/start', project ? { project } : {});
      await editors.open('display');
    }),

    'erStudio.stop': guard('stop', () => server.post('/api/run/stop')),

    'erStudio.restart': guard('restart', async () => {
      const project = await activeProject();
      await server.post('/api/run/restart', project ? { project } : {});
    }),

    'erStudio.pack': guard('pack', async () => {
      const project = await activeProject({ prompt: true });
      await server.post('/api/job/pack', project ? { project } : {});
      revealView('erStudio.console');
      vscode.window.showInformationMessage('ER Studio: packing started - watch the Console panel.');
    }),

    'erStudio.newProject': guard('scaffold', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Project name',
        validateInput: v =>
          /^[a-zA-Z0-9._-]+$/.test(v || '') ? null : 'Letters, numbers, dot, dash and underscore only'
      });
      if (!name) return;

      const picked = await vscode.window.showQuickPick(
        TEMPLATES.map(t => ({ label: t.id, description: t.blurb })),
        { placeHolder: 'Template' }
      );
      if (!picked) return;

      await server.post('/api/job/scaffold', { name, template: picked.label });
      await memento.update(PROJECT_KEY, name);
      refreshProjectItem();
      revealView('erStudio.console');
      vscode.window.showInformationMessage(`ER Studio: scaffolding ${name}.`);
    }),

    'erStudio.selectProject': guard('select project', async () => {
      const project = await pickProject({ force: true });
      if (project) {
        await memento.update(PROJECT_KEY, project);
        refreshProjectItem();
        await refreshStatus();
      }
    }),

    'erStudio.openLayout': guard('layout', () => arrangeLayout({ force: true })),

    'erStudio.openSimulator': guard('open simulator', () => editors.open('display')),

    'erStudio.openWebview': guard('open webview', () => editors.open('webview')),

    'erStudio.doctor': guard('doctor', () => runDoctor({ reveal: true })),

    'erStudio.doctorReport': guard('doctor report', async () => {
      const report = await runDoctor({ quiet: true });
      if (report) doctor.render(report);
      await doctor.show();
    }),

    'erStudio.refreshExplorer': guard('refresh projects', async () => {
      if (explorer) explorer.refresh();
    }),

    'erStudio.openReference': guard('reference', async () => {
      await server.ensure();
      revealView('erStudio.sdkref');
    }),

    'erStudio.screenshot': guard('screenshot', async () => {
      const handle = await server.ensure();
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sim/screenshot`);
      if (!res.ok) throw new Error('Simulator is not running, or its control plane is unreachable.');

      const bytes = new Uint8Array(await res.arrayBuffer());
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const target = vscode.Uri.file(path.join(server.resolveWorkspace(), `er-capture-${stamp}.png`));

      await vscode.workspace.fs.writeFile(target, bytes);
      vscode.window.showInformationMessage(`ER Studio: captured ${path.basename(target.fsPath)}`, 'Open').then(c => {
        if (c === 'Open') vscode.commands.executeCommand('vscode.open', target);
      });
    }),

    'erStudio.inputUp': input('up'),
    'erStudio.inputDown': input('down'),
    'erStudio.inputClick': input('click'),
    'erStudio.inputDoubleClick': input('double_click'),

    'erStudio.restartServer': guard('restart server', async () => {
      await server.restart();
      for (const provider of providers.values()) provider.reload();
      vscode.window.showInformationMessage('ER Studio: local server restarted.');
      await refreshStatus();
    }),

    'erStudio.openInBrowser': guard('open in browser', async () => {
      const handle = await server.ensure();
      await vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${handle.port}`));
    }),

    'erStudio.showLogs': guard('show logs', async () => output.show(true)),

    'erStudio.openWalkthrough': guard('walkthrough', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'gabrielevierti.er-studio#erStudio.getStarted',
        false
      );
    })
  };

  for (const [id, fn] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  }
}

/* ---------------- doctor ---------------- */

async function runDoctor({ reveal = false, quiet = false } = {}) {
  await server.ensure();

  if (reveal) {
    revealView('erStudio.doctor');
    const provider = providers.get('erStudio.doctor');
    if (provider) provider.send('doctorRun');
  }

  const project = await activeProject();
  const query = project ? `?project=${encodeURIComponent(project)}` : '';
  const report = await server.api(`/api/doctor${query}`);

  // The Doctor tab shows this with far more detail than a Problems entry can,
  // and the Problems panel stays about your code. The report document is still
  // built on demand by "Open Doctor Report".
  const { failed, warned } = summarise(report);
  output.appendLine(`[er-studio] doctor: ${failed} failed, ${warned} warning(s)`);

  if (!quiet && failed === 0 && warned === 0) {
    vscode.window.showInformationMessage('ER Studio: environment looks healthy.');
  } else if (quiet && failed > 0) {
    vscode.window
      .showWarningMessage(
        `ER Studio: ${failed} environment problem${failed === 1 ? '' : 's'} found.`,
        'Show Report'
      )
      .then(choice => {
        if (choice === 'Show Report') doctor.show();
      });
  }

  return report;
}

function summarise(report) {
  const s = report.summary || {};
  return { failed: s.fail || 0, warned: s.warn || 0 };
}

/* ---------------- projects ---------------- */

async function listProjects() {
  const data = await server.api('/api/fs/projects').catch(() => null);
  return (data && data.projects) || [];
}

// The desktop app has a PROJECT dropdown in its topbar. Here the choice is
// remembered per workspace and surfaced in the status bar.
async function activeProject({ prompt = false } = {}) {
  const stored = memento.get(PROJECT_KEY);
  const projects = await listProjects();

  if (stored && projects.some(p => p.name === stored)) return stored;
  if (projects.length === 1) {
    await memento.update(PROJECT_KEY, projects[0].name);
    refreshProjectItem();
    return projects[0].name;
  }
  if (projects.length === 0) return undefined;
  if (!prompt) return undefined;

  const picked = await pickProject();
  if (picked) {
    await memento.update(PROJECT_KEY, picked);
    refreshProjectItem();
  }
  return picked;
}

async function pickProject({ force = false } = {}) {
  const projects = await listProjects();
  if (projects.length === 0) {
    vscode.window.showWarningMessage('ER Studio: no projects in this workspace yet. Run "New Project from Template".');
    return undefined;
  }
  if (projects.length === 1 && !force) return projects[0].name;

  const choice = await vscode.window.showQuickPick(
    projects.map(p => ({
      label: p.name,
      description: p.hasManifest ? 'app.json' : 'no app.json'
    })),
    { placeHolder: 'Which project?' }
  );
  return choice ? choice.label : undefined;
}

function refreshProjectItem() {
  if (!projectItem) return;
  const stored = memento.get(PROJECT_KEY);
  projectItem.text = stored ? `$(folder) ${stored}` : '$(folder) no project';
  projectItem.show();
}

/* ---------------- status bar ---------------- */

async function refreshStatus() {
  if (!statusItem) return;

  // Same report the desktop status bar paints from, so the two shells can
  // never disagree about which SDK is installed.
  let version = null;
  try {
    const report = await server.api('/api/sdk');
    const cli = report.global && (report.global.cli || Object.values(report.global)[0]);
    if (cli && cli.found) version = cli.version;
  } catch {
    /* the doctor panel is where install problems get explained properly */
  }

  const running = server.state.simAlive;
  statusItem.text =
    `${running ? '$(debug-start)' : '$(circle-outline)'} Even Realities SDK ` +
    (version ? `Version ${version}` : 'Version unknown');
  statusItem.tooltip = [
    running ? 'Simulator running' : 'Simulator stopped',
    version ? `Even Hub SDK ${version}` : 'SDK version unknown - run the Doctor',
    server.workspace ? `Projects in ${server.workspace}` : 'No workspace yet',
    server.origin ? `Server ${server.origin}` : 'Server not started'
  ].join('\n');
}

// Arranges the workspace the way the tool is meant to be used:
//
//   left    VS Code's file explorer
//   right   Simulator and Webview, as editor tabs
//   bottom  Console, Terminal, Simulator Console, SDK Reference, Doctor
//
// Runs once when the ER Studio icon is first opened in a window, and on demand
// via "ER Studio: Reset Layout".
async function arrangeLayout({ force = false } = {}) {
  await server.ensure();

  // Right: webview first so the simulator ends up as the active tab.
  await editors.open('webview', vscode.ViewColumn.Two, true);
  await editors.open('display', vscode.ViewColumn.Two, false);

  // Bottom: focusing a view opens its container and makes it the active tab.
  // Console last, so that is what you are looking at.
  for (const viewId of ['erStudio.doctor', 'erStudio.sdkref', 'erStudio.simConsole', 'erStudio.console']) {
    // Each of these is its own bottom-bar tab; focusing them in this order
    // leaves Console in front.
    try {
      await vscode.commands.executeCommand(`${viewId}.focus`);
    } catch {
      /* a view the user has hidden simply does not focus */
    }
  }

  // Left: the ER Studio sidebar, which now carries the projects tree under the
  // controls - so there is no switching between two sidebars to write code and
  // drive the simulator.
  try {
    await vscode.commands.executeCommand('erStudio.explorer.focus');
  } catch {
    /* the view may be hidden by the user */
  }

  if (force) output.appendLine('[er-studio] layout arranged');
}

// The simulator toolbar mirrors the session, so it needs telling when it moves.
function broadcastSessionState() {
  if (!editors) return;
  editors.setState({
    running: !!server.state.simAlive,
    project: memento.get(PROJECT_KEY)
  });
}

// "Follow cursor" in the SDK reference used to track the Monaco editor that the
// desktop app owned. Here the editor is VS Code's, so the host has to do the
// following: the word under your cursor is sent to the reference panel, which
// looks it up.
function trackCursor(context) {
  let timer = null;

  const send = editor => {
    if (!editor || editor.document.uri.scheme !== 'file') return;
    if (!/^(typescript|javascript|typescriptreact|javascriptreact)$/.test(editor.document.languageId)) return;

    const position = editor.selection.active;
    const range = editor.document.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*/);
    if (!range) return;

    const symbol = editor.document.getText(range);
    if (!symbol || symbol.length < 2) return;

    const provider = providers.get('erStudio.sdkref');
    if (provider) provider.postMessage({ type: 'er-lookup', symbol });
  };

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(event => {
      clearTimeout(timer);
      timer = setTimeout(() => send(event.textEditor), 180);
    })
  );
}

function revealView(viewId) {
  vscode.commands.executeCommand(`${viewId}.focus`);
}

function deactivate() {
  if (server) server.dispose();
}

module.exports = { activate, deactivate };
