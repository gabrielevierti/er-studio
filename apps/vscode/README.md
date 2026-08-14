# ER Studio for VS Code

Developer tools for building Even Realities G2 (Even Hub) apps, without leaving your editor.

- **Simulator** — the 576×288 mono-green mirror with the input pad
- **Doctor** — environment diagnostics with one-click fixes, surfaced in the Problems panel
- **SDK Reference** — the API surface, searchable, beside your code
- **Console / Simulator Console / Metrics / Webview** — in the bottom panel, where output belongs

Everything runs on the same local server as the ER Studio desktop app, so the two cannot drift apart.

## Getting started

Click the glasses icon in the activity bar. ER Studio asks where you want your G2 projects to live, offers to create one if that folder is empty, and lays the workspace out:

| | |
| --- | --- |
| **Left** | ER Studio — controls, and your projects tree below them |
| **Right** | Simulator and Webview, as editor tabs |
| **Bottom** | Console · Simulator Console · SDK Reference · Doctor, each its own tab |

Move anything you like; `ER Studio: Reset Layout` puts it back. `ER Studio: Get Started` opens a short walkthrough.

Nothing is created without asking, and the folder you pick is the same one the environment doctor checks — it's stored in `erStudio.workspace`.

## Commands

| Command | What it does |
| --- | --- |
| `ER Studio: Run` | Starts the dev server and the simulator (`cmd+alt+R`) |
| `ER Studio: Stop` / `Restart` | Ends or restarts the session (`cmd+alt+S`) |
| `ER Studio: Pack .ehpk` | `npm run build` + `evenhub-cli pack` |
| `ER Studio: New Project from Template` | Scaffolds from the official Even Hub templates |
| `ER Studio: Select Active Project` | Remembered per workspace, shown in the status bar |
| `ER Studio: Run Environment Doctor` | Runs the checks and files failures under Problems |
| `ER Studio: Open Doctor Report` | The full report as a document |
| `ER Studio: Capture Simulator Screenshot` | Writes a PNG into the workspace |
| `ER Studio: Simulator Input: …` | Up / Down / Click / Double Click (`cmd+alt+arrows`) |
| `ER Studio: Restart Local Server` | After changing settings, or if the server wedges |
| `ER Studio: Open Full UI in Browser` | The complete desktop layout, editor included |

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `erStudio.workspace` | *(empty)* | Falls back to the first folder of your VS Code workspace, then `~/er-workspace` |
| `erStudio.port` | `0` | `0` picks a free port, so the desktop app can run alongside |
| `erStudio.autoStart` | `true` | Otherwise the server starts on first use |
| `erStudio.doctorOnStartup` | `true` | One quiet doctor run after startup |

`~/.er-studio.json` is still read, so a machine already set up for the desktop app needs no changes.

## What this does not do

The editor, the file tree, the terminal and panel tear-off are deliberately absent — VS Code does all four better than a bespoke shell can. What remains is the part that is specific to Even Realities development.

## Requirements

Node 18+, and the Even Hub CLI on your `PATH`. If something is missing, Doctor will name it and offer to fix it.

---

Built by [Gabriele Vierti](https://github.com/gabrielevierti). Not an official Even Realities product.
