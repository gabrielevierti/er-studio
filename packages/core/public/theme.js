/* ER Studio - theme bridge (panel side)
   ==========================================================================
   The panels are served from http://127.0.0.1:<port> and framed inside a VS
   Code webview. That is a cross-origin boundary, so the workbench's
   --vscode-* custom properties - which VS Code sets as inline styles on the
   webview's own <html> - are not inherited here.

   So the host frame reads them and posts them down. This file re-declares
   them on our :root, where theme.css is already written to consume them, and
   mirrors the workbench's body class (vscode-dark / vscode-light /
   vscode-high-contrast / vscode-high-contrast-light).

   Anything painted by JS rather than CSS - Monaco, xterm, the sparklines -
   listens for the `er-theme` event this file dispatches and re-reads the
   tokens it needs.

   Loaded first, before app.js, so the first paint is already correct when the
   host answers quickly. If no host ever answers - the server opened directly
   in a browser - nothing happens and the fallbacks in theme.css stand.
   ========================================================================== */

(function themeBridge() {
  'use strict';

  var KINDS = [
    'vscode-light',
    'vscode-dark',
    'vscode-high-contrast',
    'vscode-high-contrast-light'
  ];

  var current = null;
  var last = null;   // this file runs from <head>, so the theme can land
                     // before <body> exists - keep it and re-apply.

  function normaliseKind(kind) {
    if (!kind) return null;
    var k = String(kind);
    if (k.indexOf('vscode-') !== 0) k = 'vscode-' + k;
    return KINDS.indexOf(k) === -1 ? null : k;
  }

  function clearVsCodeVars(style) {
    for (var i = style.length - 1; i >= 0; i--) {
      var prop = style[i];
      if (prop && prop.indexOf('--vscode-') === 0) style.removeProperty(prop);
    }
  }

  function apply(message) {
    last = message;
    var root = document.documentElement;
    var vars = message.vars || {};

    // Same order VS Code itself uses: drop everything stale, then re-add.
    // A theme switch can remove variables, not only change them.
    clearVsCodeVars(root.style);
    for (var name in vars) {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) continue;
      if (name.indexOf('--vscode-') !== 0) continue;
      var value = vars[name];
      if (value === null || value === undefined || value === '') continue;
      root.style.setProperty(name, String(value));
    }

    var kind = normaliseKind(message.kind) || 'vscode-dark';
    current = kind;

    // On <html> for color-scheme, on <body> so page CSS can hook it the same
    // way it would inside a real webview.
    for (var i = 0; i < KINDS.length; i++) {
      root.classList.toggle(KINDS[i], KINDS[i] === kind);
      if (document.body) document.body.classList.toggle(KINDS[i], KINDS[i] === kind);
    }

    var light = kind === 'vscode-light' || kind === 'vscode-high-contrast-light';
    if (document.body) {
      document.body.classList.toggle('theme-light', light);
      document.body.classList.toggle('theme-dark', !light);
      document.body.dataset.themeKind = kind;
    }

    window.dispatchEvent(new CustomEvent('er-theme', {
      detail: { kind: kind, light: light }
    }));
  }

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || message.type !== 'er-theme') return;
    apply(message);
  });

  // The host pushes on load, but ask as well: a panel that is restored from a
  // hidden webview may miss the load event entirely.
  function request() {
    if (window.parent && window.parent !== window) {
      try { window.parent.postMessage({ type: 'er-theme-request' }, '*'); } catch (e) { /* no host */ }
    }
  }

  request();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      // If the host answered while we were still parsing <head>, the body
      // classes never got set. Re-run against the message we kept.
      if (last) apply(last); else request();
    });
  }

  /* Small helpers for the JS-painted surfaces. */
  window.ERTheme = {
    /** Current workbench theme kind, or null when running standalone. */
    kind: function () { return current; },
    light: function () {
      return current === 'vscode-light' || current === 'vscode-high-contrast-light';
    },
    highContrast: function () {
      return current === 'vscode-high-contrast' || current === 'vscode-high-contrast-light';
    },
    /**
     * Resolved value of a CSS custom property, e.g. token('--ok').
     * Returns `fallback` when the token is empty or unreadable.
     */
    token: function (name, fallback) {
      try {
        var value = getComputedStyle(document.documentElement)
          .getPropertyValue(name)
          .trim();
        return value || fallback || '';
      } catch (e) {
        return fallback || '';
      }
    },
    /** Same, for the --vscode-* set, so callers do not repeat the prefix. */
    vs: function (name, fallback) {
      return window.ERTheme.token('--vscode-' + name, fallback);
    },
    /** Run `fn` now and again on every theme change. */
    onChange: function (fn) {
      window.addEventListener('er-theme', fn);
      fn();
      return function () { window.removeEventListener('er-theme', fn); };
    }
  };
})();
