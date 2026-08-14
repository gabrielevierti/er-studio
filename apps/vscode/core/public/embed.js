/* ER Studio - embedded panel mode
   Runs after app.js, panels.js and sdkref.js. Its whole job is to take the
   one panel this page was asked for and move its body into a full-bleed root.

   Moving the node (rather than re-rendering it) is the same trick the dock
   uses for tear-off windows: listeners, canvas bitmaps and terminal
   scrollback all survive, so xterm and the glasses mirror keep working.

   It also bridges the panel to the extension host, so VS Code commands
   (RUN, STOP, DOCTOR) can drive a panel that lives inside a webview. */

(function embedMode() {
  'use strict';

  const panelId = document.body.getAttribute('data-embed-panel');
  if (!panelId) return;

  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

  function mount() {
    const body = document.getElementById('dock-' + panelId);
    const root = document.createElement('div');
    root.id = 'embed-root';
    document.body.appendChild(root);

    if (!body) {
      root.innerHTML =
        '<div id="embed-error">Panel <code>' +
        panelId +
        '</code> was not found in this build of ER Studio.</div>';
      return;
    }

    // panels.js may have already placed this node in a zone or a floating
    // window; appendChild moves it either way.
    root.appendChild(body);
    body.classList.add('active');

    // Panels that size themselves off their container need a nudge once they
    // are in their final box. A resize event is what they already listen for.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));

    if (vscode) vscode.postMessage({ type: 'panel-ready', panel: panelId });
  }

  // Commands invoked from the VS Code command palette arrive here. Each maps
  // to the button the desktop UI already has, so there is one implementation
  // of every action rather than two.
  function handleHostMessage(event) {
    const msg = event.data || {};

    // Panels with their own listeners (the SDK reference hears er-lookup) get
    // the message straight from the parent frame; this handler only deals with
    // the button-clicking kind.
    if (msg.type !== 'er-command') return;

    const BUTTONS = {
      run: '#btn-run',
      stop: '#btn-stop',
      restart: '#btn-restart',
      pack: '#btn-pack',
      newProject: '#btn-new-project',
      doctorRun: '#btn-doctor-run',
      clear: '#embed-root .panel-clear'
    };

    const selector = BUTTONS[msg.command];
    if (!selector) return;

    const el = document.querySelector(selector);
    if (el && !el.disabled) el.click();
  }

  window.addEventListener('message', handleHostMessage);

  if (document.readyState === 'complete') mount();
  else window.addEventListener('load', mount);
})();
