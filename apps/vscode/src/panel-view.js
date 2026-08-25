// One VS Code webview view per ER Studio panel.
//
// The webview does not reimplement anything: it frames the panel page the
// core server already serves at /embed?panel=<id>. portMapping lets that
// origin resolve inside the webview, including over Remote SSH and
// Codespaces, where 127.0.0.1 in the extension host is not 127.0.0.1 in the
// browser.

const vscode = require('vscode');
const { THEME_BRIDGE } = require('./theme-bridge');
const { openExternal } = require('./external');

class PanelViewProvider {
  /**
   * @param {import('./server-host').ServerHost} server
   * @param {string} panelId  an ER Studio panel id, e.g. 'doctor'
   */
  constructor(server, panelId) {
    this.server = server;
    this.panelId = panelId;
    this.view = null;
  }

  async resolveWebviewView(webviewView) {
    this.view = webviewView;

    webviewView.webview.options = { enableScripts: true, portMapping: [] };
    webviewView.webview.html = this.loadingHtml('Starting ER Studio\u2026');

    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg && msg.type === 'open-external') openExternal(msg.url);
    });

    webviewView.onDidDispose(() => {
      this.view = null;
    });

    await this.render();
  }

  async render() {
    if (!this.view) return;

    let handle;
    try {
      handle = await this.server.ensure();
    } catch (err) {
      this.view.webview.html = this.errorHtml(err);
      return;
    }

    this.view.webview.options = {
      enableScripts: true,
      portMapping: [{ webviewPort: handle.port, extensionHostPort: handle.port }]
    };

    this.view.webview.html = this.frameHtml(handle.port);
  }

  // Commands run from the palette are relayed into the iframe, where the
  // panel's own buttons live - so there is one implementation of every
  // action rather than two.
  send(command) {
    if (this.view) this.view.webview.postMessage({ type: 'er-command', command });
  }

  // Anything else the host needs to push into the panel page - the SDK
  // reference's cursor lookups, for instance.
  postMessage(message) {
    if (this.view) this.view.webview.postMessage(message);
  }

  reveal() {
    if (this.view) this.view.show(true);
  }

  reload() {
    return this.render();
  }

  // A theme change used to re-render, which reloads the iframe and takes the
  // terminal's scrollback and the mirror's canvas with it. The frame now
  // repaints itself from the variables the host pushes down, so there is
  // nothing left to do here.
  refreshTheme() {}

  themeName() {
    const kind = vscode.window.activeColorTheme.kind;
    if (kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight) return 'light';
    return 'dark';
  }

  frameHtml(port) {
    const src =
      `http://127.0.0.1:${port}/embed` +
      `?panel=${encodeURIComponent(this.panelId)}` +
      `&theme=${this.themeName()}`;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src http://127.0.0.1:${port}; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
  html, body {
    margin: 0; padding: 0; height: 100%; overflow: hidden;
    background: var(--vscode-panel-background, var(--vscode-editor-background));
  }
  iframe { border: 0; width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
<iframe id="panel" src="${src}" allow="clipboard-read; clipboard-write"></iframe>
<script>
  const vscodeApi = acquireVsCodeApi();
  const frame = document.getElementById('panel');

  ${THEME_BRIDGE}

  // The panel page cannot open a browser tab from inside a webview iframe, so
  // it asks us to. Only http(s) is relayed, and the ack tells the page the
  // request was taken - without it, it falls back to window.open.
  function relayExternal(msg, source) {
    if (!msg || msg.type !== 'er-open-external' || typeof msg.url !== 'string') return false;
    const ok = msg.url.slice(0, 7) === 'http://' || msg.url.slice(0, 8) === 'https://';
    if (!ok) return true;
    vscodeApi.postMessage({ type: 'open-external', url: msg.url });
    if (source) source.postMessage({ type: 'er-open-external-ok' }, '*');
    return true;
  }

  // Relay commands from the extension host down into the panel page.
  window.addEventListener('message', e => {
    const msg = e.data || {};

    // A docs link clicked inside the panel: the iframe cannot open a tab, so
    // it comes up here and goes out to the extension host.
    if (relayExternal(msg, e.source)) return;

    // The panel asks for the theme as soon as its scripts run - answer it.
    if (msg.type === 'er-theme-request') { pushTheme(); return; }

    // Everything the host addresses to the panel goes down: er-command drives
    // the panel's own buttons, er-lookup and er-reload are heard by the panel
    // script itself.
    if (msg && typeof msg.type === 'string' && msg.type.startsWith('er-') && frame.contentWindow) {
      frame.contentWindow.postMessage(msg, '*');
    }
  });
</script>
</body>
</html>`;
  }

  loadingHtml(message) {
    return `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-descriptionForeground); padding: 12px; font-size: 12px;">${message}</body></html>`;
  }

  errorHtml(err) {
    const detail = String(err && err.message ? err.message : err)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;');
    return `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; font-size: 12px; line-height: 1.6;">
      <p><strong>ER Studio could not start its local server.</strong></p>
      <pre style="white-space: pre-wrap; color: var(--vscode-errorForeground);">${detail}</pre>
      <p>Run <em>ER Studio: Restart Local Server</em> once the cause is fixed. Details are in the ER Studio output channel.</p>
    </body></html>`;
  }
}

module.exports = { PanelViewProvider };
