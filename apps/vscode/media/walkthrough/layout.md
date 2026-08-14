## Where things are

| | |
| --- | --- |
| **Left** | ER Studio — controls on top, your projects tree below |
| **Right** | Simulator and Webview, as editor tabs. Run, Stop, Restart and Capture are on the simulator's toolbar |
| **Bottom** | Console · Simulator Console · SDK Reference · Doctor, each its own tab |

One sidebar: the projects tree is right under the controls, so you're not switching between ER Studio and the Explorer to write code and drive the simulator.

There's no ER Studio terminal — VS Code's own is better, and Doctor no longer warns about the native module it would have needed.

Move anything you like; `ER Studio: Reset Layout` puts it back.

### Hiding VS Code's own panel tabs

Problems, Output and Debug Console are built into VS Code, and no extension can remove them. ER Studio writes nothing to Problems, so it stays empty — and you can hide it for good: **right-click any tab in the bottom bar and untick Problems**. VS Code remembers the choice.
