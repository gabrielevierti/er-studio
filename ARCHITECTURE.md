# Architecture

```
packages/core     server, panel UI, doctor, SDK reference   <- all the logic
apps/vscode       the VS Code extension                     <- host surfaces only
scripts/          packaging
```

## The one idea

The extension reimplements no panel. Each surface frames
`http://127.0.0.1:<port>/embed?panel=<id>`, which is the core server's own
`index.html` with the Monaco loader stripped and two small files injected:
`embed.css` hides the IDE chrome, `embed.js` lifts the requested panel
full-bleed and bridges it to the extension host.

`app.js`, `panels.js`, `sdkref.js`, the websocket and every API call run exactly
as they do in the browser UI. A fix to the Doctor panel reaches both surfaces
with no porting step, and there is no way for them to drift.

## Where each panel lives

| Surface | Why |
| --- | --- |
| Simulator, Webview | Editor tabs (`WebviewPanel`, column two) — a 576×288 mirror and a browser pane belong beside your code, not in a sidebar strip |
| Console, Simulator Console, SDK Reference, Doctor, Metrics | One panel container each, so every one is a first-class bottom tab rather than an accordion section inside a generic "ER Studio" tab |
| Controls, Projects | Activity bar, so code and the simulator are driven from one sidebar |

## Per-page loops

`app.js` wires every loop it knows about, but in embed mode a page hosts exactly
one panel. Five open panels therefore meant five copies of the 60 Hz screenshot
poll, each decoding a PNG nobody displayed.

Each page now reads `document.body.dataset.embedPanel` and runs only what its
panel needs: the mirror on the display and metrics pages, pixel read-back on
metrics alone (which also keeps the canvas GPU-backed elsewhere — `willReadFrequently`
forces a software canvas), the console poll on the simulator-console page.
The mirror is paced by `requestAnimationFrame` and pauses when hidden.

Server-side, `/api/sim/screenshot` coalesces: callers arriving while a fetch is
in flight share it, and a frame under 8 ms old is reused. Twelve simultaneous
callers cost the simulator one fetch.

## Workspace resolution

Passing a `workspace` to `startServer` **overrides** `~/.er-studio.json`, so a
guess means the server and the doctor disagree about where projects live. The
extension only passes a folder the user actually chose:

1. `erStudio.workspace` — set during setup, or by hand
2. `~/.er-studio.json` — the config the browser UI also reads
3. the open folder — only if it already contains projects
4. otherwise setup asks

## Host awareness

`startServer({ host: 'vscode' })` lets checks that only make sense in one shell
behave correctly. The terminal check is the example: the extension ships no
terminal panel, so warning about `node-pty` would be noise, and it reports
`skip` instead.

## What VS Code provides instead

| The desktop app had | Now |
| --- | --- |
| Monaco editor | VS Code's editor |
| WORKSPACE panel | The Projects tree, in the ER Studio sidebar |
| xterm + node-pty terminal | VS Code's terminal |
| Custom dock manager, tear-off windows | Editor tabs and panel drag/drop |
| Topbar RUN / STOP | The simulator tab's own toolbar |
| PROJECT dropdown | Status bar item and quick pick, remembered per workspace |
| Monaco cursor → SDK reference | `onDidChangeTextEditorSelection` → the reference panel |

## Packaging

`scripts/prepare-vscode-package.js` stages the extension outside the workspace
and installs production dependencies there, because npm workspaces hoist
dependencies to the repo root and vsce refuses to package paths outside the
extension folder.

```bash
npm install
npm run package     # -> apps/vscode/er-studio-0.1.5.vsix
```
