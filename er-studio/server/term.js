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

  // Fallback: run one command per line, stream output. Not interactive.
  send({
    type: 'term-mode',
    mode: 'exec',
    note: 'Interactive shell unavailable (node-pty missing or failed to spawn) - fallback command runner active. One command per line, output streams below. Fix: chmod +x node_modules/node-pty/build/Release/spawn-helper, or npm rebuild node-pty, then restart.'
  });
  let child = null;
  return {
    write(line) {
      const cmd = String(line).replace(/\r?\n$/, '');
      if (!cmd.trim()) return;
      if (child) { send({ type: 'term-data', data: '\r\n[busy - previous command still running]\r\n' }); return; }
      send({ type: 'term-data', data: `\r\n$ ${cmd}\r\n` });
      child = spawn('/bin/sh', ['-c', cmd], { cwd: workspaceRoot, env: process.env });
      child.stdout.on('data', d => send({ type: 'term-data', data: d.toString('utf8').replace(/\n/g, '\r\n') }));
      child.stderr.on('data', d => send({ type: 'term-data', data: d.toString('utf8').replace(/\n/g, '\r\n') }));
      child.on('exit', code => {
        send({ type: 'term-data', data: `\r\n[exit ${code}]\r\n` });
        child = null;
      });
    },
    resize() { /* noop */ },
    dispose() { if (child) { try { child.kill('SIGTERM'); } catch { /* noop */ } } }
  };
}

module.exports = { attachTerminal, hasPty: !!pty };
