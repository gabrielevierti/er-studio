// Opening a link that came from a panel page.
//
// The panel pages are ER Studio's own, but they are still a different origin
// arriving over a postMessage channel, so the URL is treated as untrusted
// input: http(s) only, parsed rather than pattern-matched, and anything else
// is dropped with a log instead of being handed to the OS.

const vscode = require('vscode');

function openExternal(raw) {
  let url;
  try { url = new URL(String(raw)); }
  catch { return false; }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.error('[er-studio] refusing to open a non-http(s) link:', url.protocol);
    return false;
  }

  vscode.env.openExternal(vscode.Uri.parse(url.toString()));
  return true;
}

module.exports = { openExternal };
