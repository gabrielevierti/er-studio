#!/usr/bin/env node
// ER Studio test suite.
//
// Runs the real core server and the real extension against a stand-in for the
// `vscode` module. Nothing below the extension layer is mocked: the server, the
// HTTP routes, the embed transform, the doctor and the onboarding flow are all
// genuine.
//
//   npm test
//
// What it cannot cover: rendering inside a live webview, and scaffolding, which
// needs the network and the Even Hub CLI.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const STUB = path.join(__dirname, 'vscode-stub.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return STUB;
  return originalResolve.call(this, request, ...args);
};

const EXT_ROOT = path.join(__dirname, '..');
const vscode = require(STUB);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` - ${detail}` : ''));
    console.log(`  \u2717 ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function makeMemento() {
  const store = new Map();
  return {
    get: k => store.get(k),
    update: (k, v) => { store.set(k, v); return Promise.resolve(); },
    __store: store
  };
}

// A workspace with one ready-made project.
function makeWorkspaceWithProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'er-ws-'));
  const project = path.join(dir, 'my-app');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'my-app' }));
  fs.writeFileSync(path.join(project, 'app.json'), '{}');
  fs.writeFileSync(path.join(project, 'src', 'main.ts'), 'export const main = () => {};\n');
  return { dir, project };
}

async function main() {
  const manifest = require(path.join(EXT_ROOT, 'package.json'));
  const { startServer, PANEL_IDS } = require(path.join(EXT_ROOT, 'core'));

  section('core server');
  const workspace = makeWorkspaceWithProject();
  const handle = await startServer({ port: 0, workspace: workspace.dir });
  const base = `http://127.0.0.1:${handle.port}`;
  check('starts on an ephemeral port', typeof handle.port === 'number' && handle.port > 0);

  const get = async p => {
    const res = await fetch(base + p);
    return { status: res.status, text: await res.text() };
  };

  section('embed routes');
  for (const panel of PANEL_IDS) {
    const res = await get(`/embed?panel=${panel}`);
    check(
      `serves ${panel}`,
      res.status === 200 &&
        res.text.includes(`data-embed-panel="${panel}"`) &&
        res.text.includes(`id="dock-${panel}"`),
      res.status !== 200 ? `status ${res.status}` : 'markup missing'
    );
  }
  check('rejects an unknown panel', (await get('/embed?panel=nope')).status === 400);

  section('api');
  const report = JSON.parse((await get('/api/doctor')).text);
  check('doctor returns checks', Array.isArray(report.checks) && report.checks.length > 0);
  check('every check has an id and status', report.checks.every(c => c.id && c.status));

  const projects = JSON.parse((await get('/api/fs/projects')).text).projects;
  check('finds the project in the workspace', projects.some(p => p.name === 'my-app'), JSON.stringify(projects));

  handle.close();

  section('onboarding: entry file detection');
  const { findEntryFile } = require(path.join(EXT_ROOT, 'src', 'onboarding.js'));
  check('prefers src/main.ts', findEntryFile(workspace.project) === path.join(workspace.project, 'src', 'main.ts'));

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'er-bare-'));
  fs.writeFileSync(path.join(bare, 'package.json'), '{}');
  check('returns null when there is no source file', findEntryFile(bare) === null);

  const oddball = fs.mkdtempSync(path.join(os.tmpdir(), 'er-odd-'));
  fs.mkdirSync(path.join(oddball, 'src'));
  fs.writeFileSync(path.join(oddball, 'src', 'entry.jsx'), '');
  check('falls back to the first source file', findEntryFile(oddball) === path.join(oddball, 'src', 'entry.jsx'));

  section('extension activation');
  vscode.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: workspace.dir } }];
  vscode.__setConfig({
    workspace: workspace.dir,   // an explicit choice, so setup does not ask
    port: 0,
    autoStart: true,
    doctorOnStartup: false,
    setupOnFirstRun: true,
    openProjectOnStartup: true
  });

  const ext = require(path.join(EXT_ROOT, 'src', 'extension.js'));
  const workspaceState = makeMemento();
  const context = { subscriptions: [], workspaceState, globalState: makeMemento() };

  ext.activate(context);
  const calls = vscode.__calls;

  // Webview views are registered through a provider; the controls view is a
  // tree view created directly, so they are checked separately.
  const allViews = Object.values(manifest.contributes.views).flat();
  const declaredViews = allViews.filter(v => v.type === 'webview').map(v => v.id);
  const declaredTreeViews = allViews.filter(v => v.type !== 'webview').map(v => v.id);
  const declaredCommands = manifest.contributes.commands.map(c => c.command);
  check(
    'registers every declared view',
    declaredViews.every(id => id in calls.views),
    declaredViews.filter(id => !(id in calls.views)).join(', ')
  );
  check(
    'registers every declared tree view',
    declaredTreeViews.every(id => id in calls.treeViews),
    declaredTreeViews.filter(id => !(id in calls.treeViews)).join(', ')
  );
  check(
    'registers every declared command',
    declaredCommands.every(id => id in calls.commands),
    declaredCommands.filter(id => !(id in calls.commands)).join(', ')
  );

  section('onboarding: an existing project is adopted');
  await new Promise(r => setTimeout(r, 4000));

  check(
    'opens the project entry file',
    calls.opened.some(p => String(p).endsWith(path.join('my-app', 'src', 'main.ts'))),
    calls.opened.join(', ') || 'nothing opened'
  );
  check(
    'shows it in the editor',
    calls.shown.some(p => String(p).endsWith('main.ts')),
    calls.shown.join(', ') || 'nothing shown'
  );
  check('remembers the active project', workspaceState.get('erStudio.activeProject') === 'my-app',
    String(workspaceState.get('erStudio.activeProject')));
  check('marks the workspace as prepared', workspaceState.get('erStudio.workspacePrepared') === true);
  check('does not scaffold when a project exists', calls.progress.length === 0, calls.progress.join(', '));

  section('onboarding: runs once');
  const { prepareWorkspace } = require(path.join(EXT_ROOT, 'src', 'onboarding.js'));
  vscode.__reset();
  const second = await prepareWorkspace({
    server: { workspace: workspace.dir, hasChosenWorkspace: () => true, api: async () => ({ projects: [] }) },
    output: { appendLine: () => {} },
    state: workspaceState
  });
  check('skips a workspace it has already prepared', second.skipped === 'already prepared', JSON.stringify(second));
  check('opens nothing on the second run', calls.opened.length === 0);

  section('onboarding: nothing is created without consent');
  vscode.__reset();
  vscode.__setConfig({ setupOnFirstRun: true, openProjectOnStartup: true, workspace: bare });

  let scaffoldAttempted = false;
  const decliningServer = {
    workspace: bare,
    hasChosenWorkspace: () => true,
    api: async () => ({ projects: [] }),
    post: async () => { scaffoldAttempted = true; return {}; },
    onEvent: () => ({ dispose() {} })
  };

  // No scripted answer: showInformationMessage resolves undefined, i.e. the
  // user dismissed the prompt.
  const declined = await prepareWorkspace({
    server: decliningServer,
    output: { appendLine: () => {} },
    state: makeMemento()
  });
  check('asks before creating a project',
    calls.info.some(m => typeof m === 'string' && m.includes('Create one from a template')),
    calls.info.filter(m => typeof m === 'string').slice(-3).join(' | '));
  check('creates nothing when dismissed', scaffoldAttempted === false && declined.skipped === 'declined',
    JSON.stringify(declined));

  vscode.__reset();
  vscode.__setConfig({ setupOnFirstRun: false, workspace: bare });
  const disabled = await prepareWorkspace({
    server: decliningServer,
    output: { appendLine: () => {} },
    state: makeMemento()
  });
  check('respects setupOnFirstRun=false', disabled.skipped === 'disabled', JSON.stringify(disabled));

  section('onboarding: the folder is the user\'s choice');
  vscode.__reset();
  vscode.__setConfig({ setupOnFirstRun: true, openProjectOnStartup: false, workspace: '' });
  const { chooseWorkspace } = require(path.join(EXT_ROOT, 'src', 'onboarding.js'));

  calls.quickPickAnswers.push('$(home) ~/er-workspace');
  const chosen = await chooseWorkspace(
    { workspace: '/tmp/somewhere' },
    { appendLine: () => {} }
  );
  check('writes the chosen folder to settings',
    calls.configWrites.some(w => w.key === 'workspace' && w.value === chosen),
    JSON.stringify(calls.configWrites));
  check('writes it globally, not per window',
    calls.configWrites.some(w => w.key === 'workspace' && w.scope !== 2), 'wrong scope');

  vscode.__reset();
  calls.quickPickAnswers.push(null); // user pressed Escape
  const cancelled = await chooseWorkspace({ workspace: '/tmp/somewhere' }, { appendLine: () => {} });
  check('changes nothing when cancelled', cancelled === null && calls.configWrites.length === 0);

  section('onboarding: survives a broken server');
  vscode.__reset();
  const brokenServer = {
    workspace: bare,
    hasChosenWorkspace: () => true,
    api: async () => { throw new Error('connection refused'); }
  };
  const survived = await prepareWorkspace({
    server: brokenServer,
    output: { appendLine: () => {} },
    state: makeMemento()
  });
  check('reports the failure instead of throwing', survived.skipped === 'server unavailable', JSON.stringify(survived));

  section('layout');
  const layoutCommands = ['erStudio.openLayout', 'erStudio.openSimulator', 'erStudio.openWebview'];
  check('layout commands are registered', layoutCommands.every(c => c in calls.commands),
    layoutCommands.filter(c => !(c in calls.commands)).join(', '));

  const containerViews = manifest.contributes.views;
  check('the sidebar holds the controls and the projects tree, in that order',
    containerViews['er-studio'].map(v => v.id).join(',') === 'erStudio.controls,erStudio.explorer',
    JSON.stringify(containerViews['er-studio'].map(v => v.id)));
  check('simulator and webview are not sidebar views',
    !Object.values(containerViews).flat().some(v => ['erStudio.display', 'erStudio.webview'].includes(v.id)));
  const panelContainers = manifest.contributes.viewsContainers.panel;
  check('each bottom panel is its own tab',
    ['Console', 'Simulator Console', 'SDK Reference', 'Doctor']
      .every(title => panelContainers.some(c => c.title === title)),
    panelContainers.map(c => c.title).join(', '));
  check('no ER Studio terminal is contributed',
    !JSON.stringify(manifest.contributes).includes('erStudio.terminal'),
    'terminal still declared');
  check('no generic "ER Studio" tab in the bottom bar',
    !panelContainers.some(c => c.title === 'ER Studio'),
    panelContainers.map(c => c.title).join(', '));
  check('every panel container holds exactly one view',
    panelContainers.every(c => (containerViews[c.id] || []).length === 1),
    JSON.stringify(Object.entries(containerViews).map(([k, v]) => `${k}:${v.length}`)));
  check('the control view is registered at runtime', 'erStudio.controls' in calls.treeViews);

  vscode.__reset();
  await calls.commands['erStudio.openLayout']();
  const titles = calls.webviewPanels.map(p => p.title);
  check('opens the simulator as an editor tab', titles.includes('Simulator'), titles.join(', ') || 'none');
  check('opens the webview as an editor tab', titles.includes('Webview'), titles.join(', ') || 'none');
  check('puts both in the second column',
    calls.webviewPanels.every(p => p.column === vscode.ViewColumn.Two),
    calls.webviewPanels.map(p => p.column).join(', '));
  check('gives the simulator focus, not the webview',
    (calls.webviewPanels.find(p => p.title === 'Webview') || {}).options !== undefined &&
    titles.indexOf('Webview') < titles.indexOf('Simulator'),
    titles.join(' -> '));
  check('focuses the bottom panel views',
    ['erStudio.doctor', 'erStudio.sdkref', 'erStudio.simConsole', 'erStudio.console']
      .every(v => calls.info.includes(`exec:${v}.focus`)),
    'missing focus calls');
  check('focuses the ER Studio projects tree, not a second sidebar',
    calls.info.includes('exec:erStudio.explorer.focus') &&
    !calls.info.includes('exec:workbench.view.explorer'));

  const simulatorPanel = calls.webviewPanels.find(p => p.title === 'Simulator');
  const reopened = calls.webviewPanels.length;
  await calls.commands['erStudio.openSimulator']();
  check('reveals an open panel instead of duplicating it',
    calls.webviewPanels.length === reopened && calls.revealed.some(r => r.title === 'Simulator'),
    `${calls.webviewPanels.length} panels`);

  section('onboarding: an empty workspace gets a starter project');
  // The real scaffold needs the network and the Even Hub CLI, so the job is
  // simulated here - everything around it is the genuine code path.
  vscode.__reset();
  vscode.__setConfig({ setupOnFirstRun: true, openProjectOnStartup: true, workspace: '' });
  calls.messageAnswers.push('Create project');   // the consent prompt
  calls.quickPickAnswers.push('minimal');        // the template

  const emptyWs = fs.mkdtempSync(path.join(os.tmpdir(), 'er-empty-'));
  const listeners = [];
  let scaffoldRequest = null;

  const fakeServer = {
    workspace: emptyWs,
    hasChosenWorkspace: () => true,
    api: async () => ({ projects: [] }),
    post: async (route, body) => {
      scaffoldRequest = { route, body };
      const src = path.join(emptyWs, body.name, 'src');
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(emptyWs, body.name, 'package.json'), '{}');
      fs.writeFileSync(path.join(src, 'main.ts'), '// starter\n');
      setTimeout(() => {
        for (const fn of [...listeners]) {
          fn({ type: 'job-done', kind: 'scaffold', code: 0, project: body.name });
        }
      }, 50);
      return {};
    },
    onEvent: fn => {
      listeners.push(fn);
      return { dispose: () => listeners.splice(listeners.indexOf(fn), 1) };
    }
  };

  let readyName = null;
  const created = await prepareWorkspace({
    server: fakeServer,
    output: { appendLine: () => {} },
    state: makeMemento(),
    onProjectReady: n => { readyName = n; }
  });

  check('scaffolds when the workspace is empty',
    scaffoldRequest && scaffoldRequest.route === '/api/job/scaffold', JSON.stringify(scaffoldRequest));
  check('uses the official minimal template',
    scaffoldRequest && scaffoldRequest.body.template === 'minimal');
  check('shows progress while it works', calls.progress.length === 1, calls.progress.join(', '));
  check('reports the project it created', created.created === true && !!created.project, JSON.stringify(created));
  check('notifies the caller of the new project', readyName === created.project);
  check('opens the new entry file', calls.opened.some(p => String(p).endsWith('main.ts')),
    calls.opened.join(', ') || 'nothing opened');
  check('offers to run it', calls.info.some(m => typeof m === 'string' && m.includes('Run it on the simulator')));
  check('leaves no dangling event listeners', listeners.length === 0, String(listeners.length));

  // A failed job must not leave the user stuck.
  vscode.__reset();
  vscode.__setConfig({ setupOnFirstRun: true, openProjectOnStartup: true, workspace: '' });
  calls.messageAnswers.push('Create project');
  calls.quickPickAnswers.push('minimal');
  const failWs = fs.mkdtempSync(path.join(os.tmpdir(), 'er-fail-'));
  const failListeners = [];
  const failingServer = {
    workspace: failWs,
    hasChosenWorkspace: () => true,
    api: async () => ({ projects: [] }),
    post: async () => {
      setTimeout(() => {
        for (const fn of [...failListeners]) fn({ type: 'job-done', kind: 'scaffold', code: 1 });
      }, 50);
      return {};
    },
    onEvent: fn => {
      failListeners.push(fn);
      return { dispose: () => failListeners.splice(failListeners.indexOf(fn), 1) };
    }
  };
  const failedSetup = await prepareWorkspace({
    server: failingServer,
    output: { appendLine: () => {} },
    state: makeMemento()
  });
  check('surfaces a failed scaffold', !!failedSetup.failed, JSON.stringify(failedSetup));
  check('warns the user when setup fails', calls.warn.length === 1, String(calls.warn.length));
  check('cleans up after a failure', failListeners.length === 0, String(failListeners.length));

  section('doctor without the problems panel');
  vscode.__reset();
  vscode.__setConfig({ workspace: workspace.dir, port: 0, doctorOnStartup: false });
  delete calls.diagnostics['ER Studio Doctor'];

  await calls.commands['erStudio.doctor']();
  check('never writes to the Problems panel',
    !calls.diagnostics['ER Studio Doctor'],
    'diagnostics were filed');
  check('registers no problem source at all',
    calls.collectionsCreated.length === 0,
    calls.collectionsCreated.join(', '));
  check('no reportToProblems setting remains',
    !('erStudio.reportToProblems' in manifest.contributes.configuration.properties));

  await calls.commands['erStudio.doctorReport']();
  check('the doctor report still opens', calls.shown.length > 0, 'nothing shown');

  section('simulator toolbar');
  // Captured during the layout section: later resets clear the recording, and
  // re-opening only reveals the existing panel rather than making a new one.
  const simPanel = simulatorPanel;
  check('the simulator has its own toolbar', !!simPanel && simPanel.webview.html.includes('id="toolbar"'));
  check('the toolbar carries run, stop and restart',
    ['erStudio.run', 'erStudio.stop', 'erStudio.restart']
      .every(c => simPanel.webview.html.includes(`data-command="${c}"`)),
    'missing buttons');
  check('the webview panel is not a general command channel',
    !simPanel.webview.html.includes('workbench.action'),
    'unexpected command reference');
  check('the controls view no longer offers Run/Stop',
    !manifest.contributes.menus['view/title']
      .some(m => m.when.includes('erStudio.controls') && ['erStudio.run', 'erStudio.stop'].includes(m.command)),
    'run/stop still on the sidebar');

  section('sdk reference follows the cursor');
  const refProvider = calls.views['erStudio.sdkref'];
  const refView = vscode.window.__makeWebviewView();
  refProvider.view = refView;

  const fireSelection = (languageId, text, hasWord = true) =>
    calls.selectionHandler({
      textEditor: {
        document: {
          uri: { scheme: 'file', fsPath: '/tmp/x.ts' },
          languageId,
          getWordRangeAtPosition: () => (hasWord ? {} : null),
          getText: () => text
        },
        selection: { active: {} }
      }
    });

  check('a selection listener is registered', typeof calls.selectionHandler === 'function');

  fireSelection('typescript', 'sendText');
  await new Promise(r => setTimeout(r, 260));
  check('sends the word under the cursor to the reference',
    refView.posted.some(m => m.type === 'er-lookup' && m.symbol === 'sendText'),
    JSON.stringify(refView.posted));

  refView.posted.length = 0;
  fireSelection('markdown', 'heading');
  await new Promise(r => setTimeout(r, 260));
  check('ignores files that are not code', !refView.posted.some(m => m.type === 'er-lookup'));

  refView.posted.length = 0;
  for (let i = 0; i < 8; i++) fireSelection('typescript', 'displayText');
  await new Promise(r => setTimeout(r, 300));
  check('debounces a burst into a single lookup',
    refView.posted.filter(m => m.type === 'er-lookup').length === 1,
    String(refView.posted.filter(m => m.type === 'er-lookup').length));

  const sdkrefSource = fs.readFileSync(
    path.join(EXT_ROOT, 'core', 'public', 'sdkref.js'), 'utf8'
  );
  check('the reference loads itself when embedded', sdkrefSource.includes("EMBED_PANEL === 'sdkref'"));
  check('the reference listens for host lookups', sdkrefSource.includes("msg.type === 'er-lookup'"));

  section('status bar');
  const sdkItem = calls.statusItems.find(i => String(i.text).includes('Even Realities SDK'));
  check('reads "Even Realities SDK Version"', !!sdkItem,
    calls.statusItems.map(i => i.text).join(' | '));

  section('walkthrough');
  const walkthrough = manifest.contributes.walkthroughs && manifest.contributes.walkthroughs[0];
  check('is declared', !!walkthrough);
  check('has an id the command can open',
    walkthrough.id === 'erStudio.getStarted');
  check('every step has media that exists',
    walkthrough.steps.every(s => !s.media || !s.media.markdown ||
      fs.existsSync(path.join(EXT_ROOT, s.media.markdown))));
  const referenced = walkthrough.steps
    .flatMap(s => s.description.match(/command:(erStudio\.[a-zA-Z]+)/g) || [])
    .map(m => m.replace('command:', ''));
  check('every referenced command exists',
    referenced.every(c => declaredCommands.includes(c)),
    referenced.filter(c => !declaredCommands.includes(c)).join(', '));
  check('the Get Started command is registered', 'erStudio.openWalkthrough' in calls.commands);

  section('one shell, no Electron');
  const repoRoot = path.join(EXT_ROOT, '..', '..');
  if (fs.existsSync(path.join(repoRoot, 'package.json'))) {
    check('no desktop app in the repo', !fs.existsSync(path.join(repoRoot, 'apps', 'desktop')));
    const root = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    check('no electron scripts remain',
      !JSON.stringify(root.scripts).includes('desktop'),
      JSON.stringify(root.scripts));
    const core = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', 'core', 'package.json'), 'utf8'));
    check('core no longer depends on node-pty',
      !JSON.stringify(core.dependencies || {}).includes('node-pty') &&
      !JSON.stringify(core.optionalDependencies || {}).includes('node-pty'));
  }

  section('manifest');
  check('every command has a category', manifest.contributes.commands.every(c => !!c.category));
  check('every setting has a description',
    Object.values(manifest.contributes.configuration.properties)
      .every(v => !!(v.description || v.markdownDescription)));
  check('the new settings are declared',
    'erStudio.setupOnFirstRun' in manifest.contributes.configuration.properties &&
    'erStudio.openProjectOnStartup' in manifest.contributes.configuration.properties);
  check('main entry exists', fs.existsSync(path.join(EXT_ROOT, manifest.main)));
  check('icon exists', fs.existsSync(path.join(EXT_ROOT, manifest.icon)));
  check('core is vendored', fs.existsSync(path.join(EXT_ROOT, 'core', 'index.js')));

  ext.deactivate();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('\ntest run threw:', err);
  process.exit(1);
});
