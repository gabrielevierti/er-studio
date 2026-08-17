// Getting the workbench theme across the iframe boundary.
//
// ER Studio's panels are served by the local core server and framed inside a
// webview, so they sit on a different origin. VS Code applies its theme to a
// webview by setting a few hundred --vscode-* custom properties as inline
// styles on that webview's own <html>, and inline styles do not cross an
// origin boundary. Without this, the panels can know *whether* the theme is
// light or dark and nothing else - which is why the old build faked light
// mode with an invert filter.
//
// So: read them here, post them down, and let theme.js on the other side
// re-declare them. Everything in theme.css then resolves against the real
// theme, including custom and third-party ones.
//
// This is emitted as a string because it has to run inside the webview
// document, not in the extension host. It expects a `frame` const to already
// be in scope and defines `pushTheme()` for the caller to invoke on request.

const THEME_BRIDGE = `
  const THEME_KINDS = ['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light'];

  function themeVars() {
    // Same enumeration VS Code itself uses when it applies them.
    const style = document.documentElement.style;
    const vars = {};
    for (let i = 0; i < style.length; i++) {
      const name = style[i];
      if (name && name.startsWith('--vscode-')) vars[name] = style.getPropertyValue(name);
    }
    return vars;
  }

  function themeKind() {
    // Longest match first: 'vscode-high-contrast' is a prefix of the light one.
    const classes = document.body.classList;
    if (classes.contains('vscode-high-contrast-light')) return 'vscode-high-contrast-light';
    if (classes.contains('vscode-high-contrast')) return 'vscode-high-contrast';
    if (classes.contains('vscode-light')) return 'vscode-light';
    return 'vscode-dark';
  }

  function pushTheme() {
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage(
      { type: 'er-theme', kind: themeKind(), vars: themeVars() },
      '*'
    );
  }

  // VS Code removes every stale property before re-adding the new set, so a
  // single theme switch fires this observer hundreds of times. Coalesce.
  let themeQueued = false;
  function queueTheme() {
    if (themeQueued) return;
    themeQueued = true;
    requestAnimationFrame(() => { themeQueued = false; pushTheme(); });
  }

  frame.addEventListener('load', pushTheme);
  new MutationObserver(queueTheme).observe(document.documentElement, {
    attributes: true, attributeFilter: ['style']
  });
  new MutationObserver(queueTheme).observe(document.body, {
    attributes: true, attributeFilter: ['class']
  });
`;

module.exports = { THEME_BRIDGE };
