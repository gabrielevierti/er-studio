// The ER Studio entry in the activity bar.
//
// Clicking the icon should produce a working layout, not a menu of things to
// arrange yourself. So this view does two jobs:
//
//   - the first time it becomes visible in a window, it arranges the workspace
//     (simulator and webview as editor tabs on the right, the panels along the
//     bottom, the file explorer on the left)
//   - it shows what is going on - which project, whether it is running - and
//     the handful of actions worth one click
//
// It is a tree view rather than a webview on purpose: it inherits the
// workbench's own styling, keyboard handling and theming for free.

const vscode = require('vscode');

class ControlsView {
  /**
   * @param {object} deps
   * @param {import('./server-host').ServerHost} deps.server
   * @param {() => { running: boolean, project: string|undefined }} deps.getState
   * @param {() => Promise<void>} deps.arrange
   */
  constructor({ server, getState, arrange }) {
    this.server = server;
    this.getState = getState;
    this.arrange = arrange;
    this.arranged = false;

    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  register(context) {
    const view = vscode.window.createTreeView('erStudio.controls', {
      treeDataProvider: this,
      showCollapseAll: false
    });

    // "Click the icon and everything is laid out" - but only once per window,
    // so re-opening the sidebar later does not rearrange the editor under you.
    view.onDidChangeVisibility(async e => {
      if (!e.visible || this.arranged) return;
      this.arranged = true;
      try {
        await this.arrange();
      } catch (err) {
        this.server.output && this.server.output.appendLine(`[er-studio] layout: ${err.message}`);
      }
    });

    context.subscriptions.push(view, this.emitter);
    this.view = view;
    return this;
  }

  refresh() {
    this.emitter.fire();
  }

  getTreeItem(item) {
    return item;
  }

  getChildren() {
    const { running, project } = this.getState();

    const item = (label, description, icon, command, tooltip) => {
      const node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      node.description = description;
      node.iconPath = new vscode.ThemeIcon(icon);
      if (command) node.command = { command, title: label };
      if (tooltip) node.tooltip = tooltip;
      return node;
    };

    // Run and Stop are deliberately absent: they live on the simulator tab's
    // own toolbar, next to the thing they act on.
    return [
      item(
        'Project',
        project || 'none selected',
        'folder',
        'erStudio.selectProject',
        this.server.workspace ? `Projects in ${this.server.workspace}` : undefined
      ),
      item(
        'Simulator',
        running ? 'running' : 'stopped',
        'device-mobile',
        'erStudio.openSimulator',
        'Open the mirror - Run and Stop are on its toolbar'
      ),
      item('New project', 'from a template', 'new-folder', 'erStudio.newProject'),
      item('Environment doctor', '', 'pulse', 'erStudio.doctor'),
      item('Pack .ehpk', '', 'package', 'erStudio.pack'),
      item('Reset layout', 'arrange the panels', 'layout', 'erStudio.openLayout'),
      item('Get started', 'walkthrough', 'book', 'erStudio.openWalkthrough')
    ];
  }
}

module.exports = { ControlsView };
