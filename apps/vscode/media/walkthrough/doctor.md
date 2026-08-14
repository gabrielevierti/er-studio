## Doctor

Checks across four groups:

- **Runtime** — Node, npm, architecture, platform support
- **SDK** — Even Hub CLI presence and version, global vs local
- **Simulator** — binary, automation port, reachability
- **Project** — `app.json`, manifest fields, build scripts

Most failures come with a fix Doctor can apply itself; the rest print the exact command to run.

Worth knowing: a VS Code launched from the Dock has a different `PATH` than your terminal, which is the usual reason a tool that "works in my terminal" appears missing here.
