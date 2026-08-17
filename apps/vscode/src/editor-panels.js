// Simulator and Webview as editor tabs.
//
// These two want to sit beside your code, not in a sidebar strip: the mirror is
// 576x288 and the webview is a browser pane. A WebviewPanel in the second
// editor column gives each its own tab, resizable and movable like any other
// editor - which is what the sidebar could never do well.
//
// The rest of the panels (console, doctor, SDK reference) stay as views in the
// bottom panel, where output belongs.

const vscode = require('vscode');
const { THEME_BRIDGE } = require('./theme-bridge');

// Only these can be invoked from a panel. A webview must never be a general
// command channel into the host.
const TOOLBAR_COMMANDS = [
  'erStudio.run',
  'erStudio.stop',
  'erStudio.restart',
  'erStudio.screenshot',
  'erStudio.doctor'
];

const TOOLBAR_HTML = `
<div id="toolbar" data-running="no">
  <button data-command="erStudio.run" data-when="stopped" class="primary">Run</button>
  <button data-command="erStudio.stop" data-when="running">Stop</button>
  <button data-command="erStudio.restart" data-when="running">Restart</button>
  <button data-command="erStudio.screenshot">Capture</button>
  <span class="spacer"></span>
  <span id="toolbar-project">No project</span>
</div>`;

const TITLES = {
  display: 'Simulator',
  webview: 'Webview'
};

const ICONS = {
  display: 'device-mobile',
  webview: 'globe'
};

class EditorPanels {
  /** @param {import('./server-host').ServerHost} server */
  constructor(server, output) {
    this.server = server;
    this.output = output;
    this.panels = new Map();
  }

  /**
   * Opens a panel, or reveals it if it is already open.
   * @param {'display'|'webview'} panelId
   */
  async open(panelId, column = vscode.ViewColumn.Two, preserveFocus = false) {
    const existing = this.panels.get(panelId);
    if (existing) {
      existing.reveal(column, preserveFocus);
      return existing;
    }

    let handle;
    try {
      handle = await this.server.ensure();
    } catch (err) {
      vscode.window.showErrorMessage(`ER Studio: ${err.message}`);
      return null;
    }

    const panel = vscode.window.createWebviewPanel(
      `erStudio.${panelId}`,
      TITLES[panelId] || panelId,
      { viewColumn: column, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        portMapping: [{ webviewPort: handle.port, extensionHostPort: handle.port }]
      }
    );

    panel.iconPath = new vscode.ThemeIcon(ICONS[panelId] || 'window');
    panel.webview.html = this.frameHtml(handle.port, panelId);

    // The simulator carries its own transport controls: an editor tab has no
    // title-bar menu to hang them off, and reaching back to the sidebar to
    // press Run defeats the point of having the mirror beside your code.
    panel.webview.onDidReceiveMessage(msg => {
      if (!msg) return;
      if (msg.type === 'run-command' && TOOLBAR_COMMANDS.includes(msg.command)) {
        vscode.commands.executeCommand(msg.command);
      }
    });

    panel.onDidDispose(() => this.panels.delete(panelId));
    this.panels.set(panelId, panel);
    return panel;
  }

  // Relays a command into the panel page, the same way the sidebar views do.
  send(panelId, command) {
    const panel = this.panels.get(panelId);
    if (panel) panel.webview.postMessage({ type: 'er-command', command });
  }

  // Keeps the toolbar's Run/Stop in step with the session.
  setState(state) {
    this.lastState = state;
    for (const panel of this.panels.values()) {
      panel.webview.postMessage({ type: 'er-state', ...state });
    }
  }

  post(panelId, message) {
    const panel = this.panels.get(panelId);
    if (panel) panel.webview.postMessage(message);
  }

  isOpen(panelId) {
    return this.panels.has(panelId);
  }

  frameHtml(port, panelId) {
    const src = `http://127.0.0.1:${port}/embed?panel=${encodeURIComponent(panelId)}`;
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src http://127.0.0.1:${port} http://localhost:${port}; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
  /* This wrapper is the only part of a panel that lives inside the webview
     origin, so it can use the --vscode-* variables directly. Everything below
     the toolbar is the framed page, which gets them via the theme bridge. */
  html, body {
    margin: 0; padding: 0; height: 100%; overflow: hidden;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
  }
  body { display: flex; flex-direction: column; }
  iframe { border: 0; width: 100%; flex: 1 1 auto; min-height: 0; display: block; }

  /* Shaped like an editor toolbar, not a second app's title bar. */
  #toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    flex: 0 0 auto;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }
  #toolbar button {
    font: inherit;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    line-height: 18px;
    padding: 3px 11px;
    cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  #toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #toolbar button.primary {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  #toolbar button.primary:hover { background: var(--vscode-button-hoverBackground); }
  #toolbar button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  #toolbar .spacer { flex: 1 1 auto; }
  #toolbar #toolbar-project { color: var(--vscode-descriptionForeground); }

  /* Run and Stop swap rather than both sitting there greyed out. */
  #toolbar[data-running="yes"] [data-when="stopped"],
  #toolbar[data-running="no"]  [data-when="running"] { display: none; }
</style>
</head>
<body>
${panelId === 'display' ? TOOLBAR_HTML : ''}
<iframe id="panel" src="${src}" allow="clipboard-read; clipboard-write"></iframe>
<script>
  const vscodeApi = acquireVsCodeApi();
  const frame = document.getElementById('panel');
  const toolbar = document.getElementById('toolbar');

  ${THEME_BRIDGE}

  if (toolbar) {
    for (const button of toolbar.querySelectorAll('button[data-command]')) {
      button.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'run-command', command: button.dataset.command });
      });
    }
  }

  window.addEventListener('message', e => {
    const msg = e.data || {};

    if (msg.type === 'er-theme-request') { pushTheme(); return; }

    if (msg.type === 'er-command' && frame.contentWindow) {
      frame.contentWindow.postMessage(msg, '*');
      return;
    }

    if (msg.type === 'er-state' && toolbar) {
      toolbar.dataset.running = msg.running ? 'yes' : 'no';
      const project = document.getElementById('toolbar-project');
      if (project) project.textContent = msg.project || 'No project';
    }
  });
</script>
</body>
</html>`;
  }

  dispose() {
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}

module.exports = { EditorPanels };
