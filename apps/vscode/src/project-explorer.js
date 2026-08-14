// A file tree for the projects folder, in the ER Studio sidebar.
//
// VS Code's own Explorer shows the folder you have open, which is not
// necessarily where your G2 projects live - and switching between two sidebars
// to write code and drive the simulator is exactly the friction this extension
// exists to remove. So the projects folder gets a tree of its own, directly
// under the ER Studio controls.
//
// Files open in the normal editor. This is a view of the same disk, not a
// second editor.

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

// Noise that would bury the actual project.
const HIDDEN = new Set(['node_modules', '.git', '.DS_Store', 'dist', 'build', '.vite', '.cache']);

class ProjectExplorer {
  /** @param {import('./server-host').ServerHost} server */
  constructor(server) {
    this.server = server;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.watcher = null;
  }

  register(context) {
    const view = vscode.window.createTreeView('erStudio.explorer', {
      treeDataProvider: this,
      showCollapseAll: true
    });
    this.view = view;
    context.subscriptions.push(view, this.emitter, { dispose: () => this.stopWatching() });
    return this;
  }

  // Re-read on the next expansion, and keep the tree honest while scaffolds and
  // builds write into the folder.
  refresh() {
    this.emitter.fire();
    this.startWatching();
  }

  startWatching() {
    const root = this.server.workspace;
    if (!root || this.watchedRoot === root) return;

    this.stopWatching();
    try {
      // Non-recursive on purpose: a recursive watch over node_modules is
      // expensive, and top-level changes are what move the tree.
      this.watcher = fs.watch(root, { persistent: false }, () => {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.emitter.fire(), 300);
      });
      this.watchedRoot = root;
    } catch {
      /* an unwatchable folder still lists fine */
    }
  }

  stopWatching() {
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* already closed */ }
    }
    this.watcher = null;
    this.watchedRoot = null;
    clearTimeout(this.debounce);
  }

  getTreeItem(node) {
    return node;
  }

  getChildren(node) {
    const root = this.server.workspace;
    if (!root) return [];

    const dir = node ? node.resourceUri.fsPath : root;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    if (!node) this.startWatching();

    return entries
      .filter(e => !HIDDEN.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map(entry => this.toItem(dir, entry, !node));
  }

  toItem(dir, entry, isTopLevel) {
    const full = path.join(dir, entry.name);
    const uri = vscode.Uri.file(full);

    const item = new vscode.TreeItem(
      uri,
      entry.isDirectory()
        ? isTopLevel
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    // A top-level folder with a package.json is a project, not just a folder.
    if (isTopLevel && entry.isDirectory() && fs.existsSync(path.join(full, 'package.json'))) {
      item.contextValue = 'erStudio.project';
      item.description = fs.existsSync(path.join(full, 'app.json')) ? '' : 'no app.json';
      item.iconPath = new vscode.ThemeIcon('device-mobile');
      item.tooltip = full;
    }

    if (!entry.isDirectory()) {
      item.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [uri]
      };
    }

    return item;
  }
}

module.exports = { ProjectExplorer };
