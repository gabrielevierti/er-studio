// Single-panel embedding.
//
// The VS Code extension shows one ER Studio panel per webview. Rather than
// maintaining a second copy of the UI, /embed serves the *same* index.html
// with two additions and one removal:
//
//   + embed.css   hides the topbar, editor zone, splitters and dock tabs
//   + embed.js    lifts the requested panel out of the dock into a full-bleed root
//   - the Monaco loader, since an embedded panel never hosts the editor
//
// Everything else - app.js, panels.js, sdkref.js, the websocket, every API
// call - runs exactly as it does in the desktop app. A change to a panel is
// picked up by both shells with no porting step.

const fs = require('fs');
const path = require('path');
const express = require('express');

const INDEX_PATH = path.join(__dirname, '..', 'public', 'index.html');

// Panels the embed route will serve. Anything else is a bad request rather
// than a blank webview that is hard to debug.
const EMBEDDABLE = new Set([
  'workspace',
  'display',
  'webview',
  'terminal',
  'process',
  'glasses-console',
  'metrics',
  'doctor',
  'sdkref'
]);

const MONACO_TAG = /\s*<script src="vendor\/monaco\/vs\/loader\.js"><\/script>\r?\n?/;

function buildEmbedHtml(panel, theme) {
  let html = fs.readFileSync(INDEX_PATH, 'utf8');

  // The editor belongs to the host now.
  html = html.replace(MONACO_TAG, '\n');

  html = html.replace(
    '</head>',
    '<link rel="stylesheet" href="embed.css">\n</head>'
  );

  // The panel id travels in the markup rather than the query string so the
  // embed script does not have to care how the page was reached.
  html = html.replace(
    '<body>',
    `<body class="embed theme-${theme}" data-embed-panel="${panel}" data-embed-theme="${theme}">`
  );

  // Last script: app.js, panels.js and sdkref.js have all registered by then.
  html = html.replace(
    '</body>',
    '<script src="embed.js"></script>\n</body>'
  );

  return html;
}

function createEmbedRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    const panel = String(req.query.panel || '');
    if (!EMBEDDABLE.has(panel)) {
      return res
        .status(400)
        .type('text/plain')
        .send(`Unknown panel "${panel}". Expected one of: ${[...EMBEDDABLE].join(', ')}`);
    }

    const theme = req.query.theme === 'light' ? 'light' : 'dark';

    try {
      res.type('html').send(buildEmbedHtml(panel, theme));
    } catch (err) {
      res.status(500).type('text/plain').send(`Could not build embed page: ${err.message}`);
    }
  });

  return router;
}

module.exports = { createEmbedRouter, EMBEDDABLE };
