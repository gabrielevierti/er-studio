# ER Studio 0.1.7

## Long press in the simulator pad

The input pad now has a **Long press** button, and it behaves like the hardware:
press and release are two separate events (`long_press`, `long_press_release`),
matching the SDK's `LONG_PRESS_EVENT` (9) and `LONG_PRESS_RELEASE_EVENT` (10).
Sending both on a single click would make any hold-to-confirm or
progress-while-held app look broken, so the button is a genuine hold — it stays
lit while down, and releases on pointerup, pointercancel or window blur so a
press can never get stuck.

`server/sim.js` no longer keeps a hard-coded allow-list of input actions. It
validates the *shape* of an action (lowercase snake_case) and lets the simulator
be the authority on which ones exist. A new simulator action is usable
immediately, with no ER Studio release. `GET /api/sim/actions` lists the known
ones for reference; an action this simulator build doesn't know comes back as
its own 4xx and surfaces as a toast pointing at the upgrade.

## Docs buttons work inside VS Code

They were never broken links. Every DOCS button is an `<a target="_blank">`, and
the panel page is an iframe inside a webview — which cannot open a top-level
window. The click was swallowed with no error, so the buttons looked dead.

Now: a single delegated handler in `public/app.js` catches http(s) link clicks
when the page is framed and posts them up as `er-open-external`. Both webview
shells relay that to the extension host, which validates the URL (parsed, not
pattern-matched, http/https only) and opens it with `vscode.env.openExternal`.
If nothing acks within 500 ms — the page is framed by something that isn't the
extension — it falls back to `window.open` rather than eating the click twice.

Because it's delegated, every docs link works: doctor fixes, SDK reference
symbol and member links, and anything added later, with no per-link wiring.

## The SDK reference tracks npm, not the build

This is the one that was forcing a new release every time Even shipped an SDK.
The reference had two sources: the `.d.ts` in the selected project's
`node_modules`, and a snapshot baked into the repo at build time.

New resolution order:

1. the SDK installed in the selected project — what your code actually imports,
   so it still wins whenever it exists
2. **the latest published SDK, pulled from the npm registry at runtime**
3. the bundled snapshot — offline, first run, nothing installed

New `server/npm-fetch.js` queries the registry and unpacks the tarball in
memory. No new dependency (small ustar reader), no npm subprocess, nothing
written into your projects. Results cache to `~/.er-studio/sdk-ref/` with a 6h
TTL and single-flight, so ten panels don't mean ten downloads. Refresh runs in
the background whenever something is already servable; every failure falls
through silently to what you had, because an offline laptop must not turn the
panel into an error. **Reload** forces a re-check.

Two knock-on wins:

- `/api/sdkref/dts` serves the latest published types when a project has no
  `node_modules` yet, so Monaco completion on `bridge.` works before the first
  `npm install`
- the payload carries `latestPublished` / `updateAvailable`, so the panel shows
  "0.0.15 published" instead of you finding out later

The doctor's `overlayStale` check dropped from **warn** to **pass-with-note**.
Under the new model, the hand-written English overlay lagging the SDK is the
normal state of the world on the morning of every Even release — signatures are
always current, only the prose lags — and a check that cries wolf on schedule is
one you learn to ignore.

## Notes

- The exact automation action string for long press could not be verified: npm
  blocks fetching and the docs don't publish the action list. `long_press` /
  `long_press_release` mirror the SDK event names. If Even chose otherwise,
  it's now one attribute in `index.html`, not a server patch.
- `apps/vscode/core/` has been re-vendored from `packages/core/`.
- Run `apps/vscode/test/run.js` and the package script locally before shipping;
  neither could run here (no `express`, no network).
