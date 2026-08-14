// @er-studio/core
//
// Everything that is not a shell lives here: the express + ws server, the
// panel UI in public/, the doctor checks, the SDK reference and the process
// manager that drives vite and the simulator.
//
// The VS Code extension (apps/vscode) is the shell. It owns no product logic of
// its own - it supplies the host surfaces (views, commands, status bar) and
// everything else lives here.
//
// `npm start` serves the same UI at http://127.0.0.1:4477 in a browser, with
// the editor and terminal panels the extension deliberately leaves to VS Code.
// That is what "ER Studio: Open Full UI in Browser" opens.

const path = require('path');
const { startServer } = require('./server/index.js');

// Where the panel UI is served from. The VS Code extension needs this to know
// which origin its webviews may frame.
const PUBLIC_DIR = path.join(__dirname, 'public');

const PANEL_IDS = [
  'workspace',
  'display',
  'webview',
  'terminal',
  'process',
  'glasses-console',
  'metrics',
  'doctor',
  'sdkref'
];

module.exports = { startServer, PUBLIC_DIR, PANEL_IDS };
