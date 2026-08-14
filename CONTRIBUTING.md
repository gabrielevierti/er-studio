# Contributing

## Layout

```
packages/core     the server, the panel UI, doctor, SDK reference   <- all the logic
apps/vscode       the VS Code extension                             <- host surfaces only
scripts/          packaging
```

The rule that keeps this maintainable: **product behaviour goes in
`packages/core`, host integration goes in `apps/vscode`.** If you find yourself
writing a doctor check or a panel inside the extension, it belongs in core.

## Running it

```bash
npm install
code apps/vscode      # then press F5
```

F5 loads the extension from source, so edits to either side are one reload away
(`Cmd+R` in the extension host window).

To work on a panel with normal devtools, serve the UI in a browser instead:

```bash
npm start             # http://127.0.0.1:4477
```

## Tests

```bash
npm test
```

The suite runs the real core server and the real extension against a stand-in
for the `vscode` module (`apps/vscode/test/vscode-stub.js`). Nothing below the
extension layer is mocked, so a passing run means the server, the routes, the
embed transform, the doctor and the onboarding paths genuinely work. It does not
cover rendering inside a live webview — that still needs a human with a
simulator.

Add a check to `apps/vscode/test/run.js` for anything you fix. It is plain Node,
no framework.

## Adding a panel

1. Add the markup to `packages/core/public/index.html` as a `.dock-panel` with
   `id="dock-<id>"`.
2. Add `<id>` to `PANEL_IDS` in `packages/core/index.js` and to `EMBEDDABLE` in
   `packages/core/server/embed.js`.
3. If it needs a polling loop, gate it in `app.js` with `pageNeeds('<id>')` —
   every embedded page runs `app.js`, so an ungated loop runs once per open
   panel.
4. Contribute a panel container plus one view in `apps/vscode/package.json`, and
   add the view to `VIEWS` in `apps/vscode/src/extension.js`.

One container per view is deliberate: several views in one container render as
accordion sections inside a single generic tab.

## Adding a doctor check

Checks live in `packages/core/server/doctor.js`. Give each one an `id`, a
`group`, a `label` and, where possible, a `fix` with an `auto` handler or a
`command` string. If a check only makes sense in one shell, branch on
`ctx.host` — it is `'vscode'` or `'browser'`.

## Packaging

```bash
npm run package       # -> apps/vscode/er-studio-0.1.5.vsix
```

`scripts/prepare-vscode-package.js` stages the extension outside the workspace
and installs production dependencies there. npm workspaces hoist dependencies to
the repo root, and vsce refuses to package paths outside the extension folder.

## Lockfile

`package-lock.json` was removed along with the Electron app — it still described
Electron and its dependency tree. Run `npm install` once and commit the fresh
one.
