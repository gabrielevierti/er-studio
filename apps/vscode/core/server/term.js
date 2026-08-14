// ER Studio - integrated terminal
// Preferred: node-pty (full interactive shell). If node-pty failed to build,
// falls back to a line-based command runner so the panel still works.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let pty = null;
try {
  pty = require('node-pty');
  // Known node-pty packaging issue on macOS: spawn-helper ships without the
  // execute bit, which makes pty.fork throw "posix_spawnp failed" at runtime.
  const helper = path.join(path.dirname(require.resolve('node-pty')), '..', 'build', 'Release', 'spawn-helper');
  if (fs.existsSync(helper)) {
    try { fs.chmodSync(helper, 0o755); } catch { /* best effort */ }
  }
} catch { /* optional dependency */ }

function attachTerminal(ws, workspaceRoot, send) {
  if (pty) {
    const shell = process.env.SHELL || '/bin/zsh';
    let term = null;
    try {
      term = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        env: process.env
      });
    } catch (err) {
      console.error(`[er-studio] pty spawn failed (${err.message}) - falling back to command runner`);
      term = null;
    }
    if (term) {
      term.onData(data => send({ type: 'term-data', data }));
      term.onExit(({ exitCode }) => send({ type: 'term-exit', code: exitCode }));
      send({ type: 'term-mode', mode: 'pty', shell });
      return {
        write(data) { try { term.write(data); } catch { /* pty gone */ } },
        resize(cols, rows) { try { term.resize(cols, rows); } catch { /* noop */ } },
        dispose() { try { term.kill(); } catch { /* noop */ } }
      };
    }
  }

  // Fallback: line-based command runner. node-pty normally provides echo and
  // line editing; without it we implement a minimal line discipline here:
  // buffer keystrokes, echo them, handle Backspace/Ctrl+C, execute on Enter.
  send({
    type: 'term-mode',
    mode: 'exec',
    note: 'Interactive shell unavailable (node-pty missing or failed to spawn) - fallback command runner active. One command per line. Fix: chmod +x node_modules/node-pty/build/Release/spawn-helper, or npm rebuild node-pty (Node 22 LTS recommended), then restart.'
  });

  let child = null;
  let buffer = '';
  const PROMPT = '$ ';
  const echo = data => send({ type: 'term-data', data });
  echo('\r\n' + PROMPT);

  function execute(cmd) {
    if (child) { echo('[busy - previous command still running]\r\n'); return; }
    if (!cmd.trim()) { echo(PROMPT); return; }
    child = spawn('/bin/sh', ['-c', cmd], { cwd: workspaceRoot, env: process.env });
    child.stdout.on('data', d => echo(d.toString('utf8').replace(/\n/g, '\r\n')));
    child.stderr.on('data', d => echo(d.toString('utf8').replace(/\n/g, '\r\n')));
    child.on('exit', code => {
      echo(`\r\n[exit ${code}]\r\n` + PROMPT);
      child = null;
    });
  }

  return {
    write(data) {
      const str = String(data);
      // Arrow keys etc. arrive as escape sequences in their own chunk - drop them.
      if (str.startsWith('\x1b')) return;
      for (const ch of str) {
        if (ch === '\r' || ch === '\n') {           // Enter
          echo('\r\n');
          const cmd = buffer;
          buffer = '';
          execute(cmd);
        } else if (ch === '\x7f' || ch === '\b') {  // Backspace
          if (buffer.length > 0) { buffer = buffer.slice(0, -1); echo('\b \b'); }
        } else if (ch === '\x03') {                 // Ctrl+C
          if (child) { try { child.kill('SIGINT'); } catch { /* noop */ } }
          buffer = '';
          echo('^C\r\n' + PROMPT);
        } else if (ch >= ' ' || ch === '\t') {      // printable
          buffer += ch;
          echo(ch);
        }
      }
    },
    resize() { /* noop */ },
    dispose() { if (child) { try { child.kill('SIGTERM'); } catch { /* noop */ } } }
  };
}

module.exports = { attachTerminal, hasPty: !!pty };
