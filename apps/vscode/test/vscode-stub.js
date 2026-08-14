// A stand-in for the `vscode` module.
//
// The real API only exists inside a running extension host, which makes the
// interesting parts of an extension awkward to test. This implements enough of
// it to activate the extension for real - registering views and commands,
// driving them, and recording what came back.
//
// Everything below the extension (the core server, the HTTP routes, the doctor,
// the onboarding flow) is the genuine article, not a mock.

const { EventEmitter: NodeEmitter } = require('events');

const calls = {
  commands: {},
  views: {},
  statusItems: [],
  diagnostics: {},
  opened: [],
  shown: [],
  info: [],
  warn: [],
  error: [],
  progress: [],
  treeViews: {},
  visibilityHandlers: {},
  webviewPanels: [],
  revealed: [],
  configWrites: [],
  openDialogResult: null,
  selectionHandler: null,
  collectionsCreated: [],
  quickPickAnswers: [],
  messageAnswers: []
};

let config = {};

class EventEmitter {
  constructor() {
    this._e = new NodeEmitter();
    this.event = fn => { this._e.on('e', fn); return { dispose() {} }; };
  }
  fire(v) { this._e.emit('e', v); }
  dispose() {}
}

const vscode = {
  __calls: calls,
  __setConfig: c => { config = c; },
  __reset: () => {
    for (const key of ['opened', 'shown', 'info', 'warn', 'error', 'progress', 'revealed', 'configWrites', 'webviewPanels']) {
      calls[key].length = 0;
    }
    calls.quickPickAnswers.length = 0;
    calls.messageAnswers.length = 0;
  },

  Uri: {
    parse: s => ({ toString: () => s, scheme: String(s).split(':')[0], fsPath: s }),
    file: p => ({ fsPath: p, scheme: 'file', toString: () => 'file://' + p })
  },
  Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  DiagnosticRelatedInformation: class { constructor(loc, msg) { Object.assign(this, { loc, msg }); } },
  Location: class { constructor(uri, range) { Object.assign(this, { uri, range }); } },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  EventEmitter,

  window: {
    activeColorTheme: { kind: 2 },
    createOutputChannel: () => ({ appendLine: m => calls.info.push(m), show() {}, dispose() {} }),
    createStatusBarItem: () => {
      const item = { text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} };
      calls.statusItems.push(item);
      return item;
    },
    registerWebviewViewProvider: (id, provider) => { calls.views[id] = provider; return { dispose() {} }; },
    showErrorMessage: m => { calls.error.push(m); return Promise.resolve(); },
    showWarningMessage: m => { calls.warn.push(m); return Promise.resolve(); },
    showInformationMessage: (m, ...actions) => {
      calls.info.push(m);
      const scripted = calls.messageAnswers && calls.messageAnswers.shift();
      return Promise.resolve(scripted !== undefined ? scripted : undefined);
    },
    showQuickPick: items => {
      const scripted = calls.quickPickAnswers.shift();
      if (scripted === undefined) return Promise.resolve(items[0]);
      if (scripted === null) return Promise.resolve(undefined);
      const list = Array.isArray(items) ? items : [];
      const match = list.find(i => (i.label || i) === scripted);
      return Promise.resolve(match !== undefined ? match : scripted);
    },
    showInputBox: () => Promise.resolve('demo-app'),
    showTextDocument: doc => { calls.shown.push(doc && doc.uri ? doc.uri.fsPath : doc); return Promise.resolve(); },
    withProgress: (options, task) => { calls.progress.push(options.title); return task({ report() {} }); },
    onDidChangeActiveColorTheme: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection: fn => { calls.selectionHandler = fn; return { dispose() {} }; },
    activeTextEditor: null,
    showOpenDialog: () => Promise.resolve(calls.openDialogResult || undefined),
    // Builds a webview view the way VS Code would hand one to a provider.
    __makeWebviewView: () => {
      const posted = [];
      const handlers = [];
      return {
        posted,
        handlers,
        webview: {
          options: null,
          html: '',
          postMessage: m => { posted.push(m); return Promise.resolve(true); },
          onDidReceiveMessage: fn => { handlers.push(fn); return { dispose() {} }; }
        },
        onDidDispose: () => ({ dispose() {} }),
        show: () => {}
      };
    },
    createTreeView: (id, options) => {
      const view = {
        id,
        provider: options.treeDataProvider,
        visible: false,
        onDidChangeVisibility: fn => { calls.visibilityHandlers[id] = fn; return { dispose() {} }; },
        dispose() {}
      };
      calls.treeViews[id] = view;
      return view;
    },
    createWebviewPanel: (type, title, showOptions, options) => {
      const panel = {
        type,
        title,
        column: showOptions && showOptions.viewColumn,
        options,
        iconPath: null,
        disposed: false,
        posted: [],
        webview: {
          html: '',
          options,
          postMessage: m => { panel.posted.push(m); return Promise.resolve(true); },
          onDidReceiveMessage: fn => { panel.handlers.push(fn); return { dispose() {} }; }
        },
        handlers: [],
        reveal: (column, preserveFocus) => { calls.revealed.push({ title, column, preserveFocus }); },
        onDidDispose: fn => { panel.__onDispose = fn; return { dispose() {} }; },
        dispose() { this.disposed = true; if (this.__onDispose) this.__onDispose(); }
      };
      calls.webviewPanels.push(panel);
      return panel;
    }
  },

  commands: {
    registerCommand: (id, fn) => { calls.commands[id] = fn; return { dispose() {} }; },
    executeCommand: id => { calls.info.push('exec:' + id); return Promise.resolve(); }
  },

  languages: {
    createDiagnosticCollection: name => (calls.collectionsCreated.push(name), {
      name,
      set: (uri, d) => { calls.diagnostics[name] = d; },
      clear() {},
      dispose() {}
    })
  },

  workspace: {
    workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/tmp/er-workspace' } }],
    getConfiguration: () => ({
      get: k => config[k],
      update: (k, v) => { config[k] = v; calls.configWrites.push({ key: k, value: v }); return Promise.resolve(); }
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    openTextDocument: uri => {
      calls.opened.push(uri && uri.fsPath ? uri.fsPath : uri);
      return Promise.resolve({ uri });
    },
    fs: { writeFile: () => Promise.resolve() }
  },

  env: { openExternal: () => Promise.resolve(true) }
};

module.exports = vscode;
