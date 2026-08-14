## Your projects folder

ER Studio keeps all G2 projects in one folder. You chose it during setup, and it's stored in `erStudio.workspace`.

That setting is what the server *and* the environment doctor both use — so if Doctor ever reports a different path than you expect, it's this setting to change.

When it's empty, ER Studio falls back to the `workspace` value in `~/.er-studio.json` (shared with the browser UI), then `~/er-workspace`.

New projects: `ER Studio: New Project from Template` — minimal, speech recognition, image rendering, or long-text paging.
