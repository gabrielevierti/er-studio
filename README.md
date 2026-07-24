# ER Studio

Integrated development console for Even Realities G2 (Even Hub) apps. Single window: file explorer, Monaco editor, live glasses display mirror, phone webview, terminal, process logs, glasses console, and session metrics.

## How it works

The official `evenhub-simulator` (v0.7.0+) exposes an HTTP automation control plane when launched with `--automation-port`. ER Studio runs the simulator and your Vite dev server as managed child processes, then mirrors the glasses framebuffer into the UI by polling `GET /api/screenshot/glasses` (~8 fps), streams app logs from `GET /api/console`, and injects TouchBar gestures via `POST /api/input`. The native simulator window still opens — leave it minimized; you never need to look at it.

```
browser UI (127.0.0.1:4477)
   │  REST + WebSocket
ER Studio server (Node)
   ├─ /api/fs    workspace file system (path-traversal hardened)
   ├─ /api/run   session control → spawns: npm run dev  +  evenhub-simulator <url> --automation-port 9898
   ├─ /api/sim   proxy → simulator control plane on 127.0.0.1:9898
   └─ /ws        status events, process logs, pty terminal
```

## Requirements

- macOS, Node.js ≥ 18
- Even Hub tooling (installed globally or resolved on demand via npx):
  `npm i -g @evenrealities/evenhub-simulator @evenrealities/evenhub-cli`
- For the full interactive terminal: Xcode Command Line Tools (node-pty is a native module). If it fails to build, ER Studio falls back to a non-interactive command runner automatically.

## Run

```
npm install
node server/index.js --workspace ~/dev/even-projects
# open http://127.0.0.1:4477
```

Flags: `--workspace <dir>` (default `~/er-workspace`), `--port <n>` (default 4477).

The server binds to 127.0.0.1 only.

## Workflow

1. NEW → scaffold from the official `evenhub-templates` (minimal / asr / image / text-heavy); runs degit + npm install.
2. Edit in Monaco. Cmd+S saves. Dirty files are auto-saved on RUN.
3. RUN → starts `npm run dev`, detects the Vite port from stdout, launches the simulator against it. STOP kills both process groups. RESTART recycles the session.
4. Glasses display panel mirrors the framebuffer; TouchBar buttons send up / down / tap / double-tap. CAPTURE downloads the current frame as PNG. Phone webview panel embeds the Vite page directly.
5. Dock: TERMINAL (real shell), PROCESS LOG (vite + sim + jobs), GLASSES CONSOLE (app console.*, exceptions, failed fetches — errors badge the tab), METRICS.
6. PACK .EHPK → `npm run build` then `evenhub-cli pack app.json dist` in the project directory.

## Metrics honesty

The simulator is not a hardware emulator: frame pacing, BLE timing, and on-device performance are not reproduced. Panel metrics (boot → first render, lit pixels, frame delta, console error rate, mirror latency) describe the simulator session, not the glasses. Always validate on hardware before submission.

## Notes

- The framebuffer PNG is RGBA where lit pixels have alpha > 0; the lit-pixel and frame-delta metrics use that rule (same as the official automation docs recommend).
- Input sent before the app's first event-capturing container exists is silently dropped by the simulator — wait for first render.
- `since_id` incremental polling is used for the glasses console; CLEAR also clears the simulator-side buffer.
