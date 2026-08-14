// First-run setup.
//
// Two rules, both learned the hard way:
//
//   1. Ask before creating anything. A tool that scaffolds a project into a
//      folder you did not choose is not being helpful.
//   2. Whatever folder is chosen must be the one the server uses, so the
//      doctor and the extension never disagree about where projects live.
//      Passing a workspace to startServer overrides ~/.er-studio.json, so the
//      choice is written to the erStudio.workspace setting and the server is
//      restarted with it.
//
// Runs once per workspace. Everything is best-effort: if the user cancels or
// something fails, the extension is exactly as usable as it was before.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const DONE_KEY = 'erStudio.workspacePrepared';
const STARTER_TEMPLATE = 'minimal';

const ENTRY_CANDIDATES = [
  'src/main.ts',
  'src/main.js',
  'src/index.ts',
  'src/index.js',
  'src/app.ts',
  'src/app.js',
  'index.html',
  'app.json'
];

function findEntryFile(projectDir) {
  for (const candidate of ENTRY_CANDIDATES) {
    const full = path.join(projectDir, candidate);
    if (fs.existsSync(full)) return full;
  }

  const srcDir = path.join(projectDir, 'src');
  const dir = fs.existsSync(srcDir) ? srcDir : projectDir;
  try {
    const first = fs
      .readdirSync(dir)
      .filter(f => /\.(ts|js|tsx|jsx|html)$/.test(f))
      .sort()[0];
    return first ? path.join(dir, first) : null;
  } catch {
    return null;
  }
}

async function openEntryFile(projectDir, output) {
  const entry = findEntryFile(projectDir);
  if (!entry) return false;
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry));
    await vscode.window.showTextDocument(doc, { preview: false });
    return true;
  } catch (err) {
    output.appendLine(`[er-studio] could not open ${entry}: ${err.message}`);
    return false;
  }
}

function countProjects(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'package.json')))
      .length;
  } catch {
    return 0;
  }
}

// Asks where projects should live, offering whatever sensible candidates exist
// rather than a bare file dialog.
async function chooseWorkspace(server, output) {
  const current = server.workspace;
  const openFolder =
    vscode.workspace.workspaceFolders &&
    vscode.workspace.workspaceFolders[0] &&
    vscode.workspace.workspaceFolders[0].uri.scheme === 'file'
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : null;

  const options = [];
  const seen = new Set();

  const add = (dir, label, detail) => {
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    const n = countProjects(dir);
    options.push({
      label,
      description: dir.replace(os.homedir(), '~'),
      detail: n > 0 ? `${n} project${n === 1 ? '' : 's'} here${detail ? ' \u00b7 ' + detail : ''}` : detail,
      dir
    });
  };

  if (current) add(current, '$(check) Use the current folder', 'from ~/.er-studio.json or the default');
  if (openFolder) add(openFolder, '$(folder-opened) Use the folder open in VS Code');
  add(path.join(os.homedir(), 'er-workspace'), '$(home) ~/er-workspace');

  options.push({
    label: '$(folder) Choose another folder\u2026',
    description: 'pick any folder on disk',
    dir: null
  });

  const picked = await vscode.window.showQuickPick(options, {
    title: 'ER Studio - where should your G2 projects live?',
    placeHolder: 'This is where projects are created and found',
    ignoreFocusOut: true
  });

  if (!picked) return null;

  let chosen = picked.dir;
  if (!chosen) {
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Use this folder',
      title: 'Where should ER Studio keep your G2 projects?'
    });
    if (!uris || uris.length === 0) return null;
    chosen = uris[0].fsPath;
  }

  // Written to settings so the server, the doctor and the next window all
  // agree. Global scope: a projects folder is a property of the machine, not
  // of one window.
  await vscode.workspace
    .getConfiguration('erStudio')
    .update('workspace', chosen, vscode.ConfigurationTarget.Global);

  output.appendLine(`[er-studio] workspace set to ${chosen}`);
  return chosen;
}

function waitForScaffold(server, timeoutMs = 6 * 60 * 1000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve({ ok: false, reason: 'timed out' });
    }, timeoutMs);

    const subscription = server.onEvent(msg => {
      if (msg.type !== 'job-done' || msg.kind !== 'scaffold') return;
      clearTimeout(timer);
      subscription.dispose();
      resolve(
        msg.code === 0
          ? { ok: true, project: msg.project }
          : { ok: false, reason: `the scaffold job exited with code ${msg.code}` }
      );
    });
  });
}

async function offerStarterProject(server, output) {
  const answer = await vscode.window.showInformationMessage(
    'No G2 projects in this folder yet. Create one from a template?',
    'Create project',
    'Not now'
  );
  if (answer !== 'Create project') return null;

  const name = await vscode.window.showInputBox({
    title: 'New project',
    prompt: 'Project name',
    value: 'hello-g2',
    ignoreFocusOut: true,
    validateInput: v =>
      /^[a-zA-Z0-9._-]+$/.test(v || '') ? null : 'Letters, numbers, dot, dash and underscore only'
  });
  if (!name) return null;

  const templates = [
    { label: 'minimal', description: 'Bare scaffold, single page', picked: true },
    { label: 'asr', description: 'Speech recognition (mic stream)' },
    { label: 'image', description: 'Image rendering pipeline' },
    { label: 'text-heavy', description: 'Paging / long text UI' }
  ];
  const template = await vscode.window.showQuickPick(templates, {
    title: 'Template',
    placeHolder: 'Which template?',
    ignoreFocusOut: true
  });
  if (!template) return null;

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `ER Studio: creating ${name}`,
      cancellable: false
    },
    async progress => {
      progress.report({ message: 'fetching the template and installing dependencies\u2026' });
      const settled = waitForScaffold(server);
      try {
        await server.post('/api/job/scaffold', { name, template: template.label || STARTER_TEMPLATE });
      } catch (err) {
        return { ok: false, reason: err.message };
      }
      return settled;
    }
  );
}

/**
 * @param {object} options
 * @param {import('./server-host').ServerHost} options.server
 * @param {vscode.OutputChannel} options.output
 * @param {vscode.Memento} options.state
 * @param {(name: string) => void} [options.onProjectReady]
 * @param {() => Promise<void>} [options.onWorkspaceChanged]  restart the server
 */
async function prepareWorkspace({ server, output, state, onProjectReady, onWorkspaceChanged }) {
  if (state.get(DONE_KEY)) return { skipped: 'already prepared' };

  const config = vscode.workspace.getConfiguration('erStudio');
  if (!config.get('setupOnFirstRun')) {
    await state.update(DONE_KEY, true);
    return { skipped: 'disabled' };
  }

  // Ask only when there is a real question: no explicit choice on record.
  if (!server.hasChosenWorkspace()) {
    const chosen = await chooseWorkspace(server, output);
    if (!chosen) return { skipped: 'cancelled' };

    if (onWorkspaceChanged && path.resolve(chosen) !== path.resolve(server.workspace || '')) {
      await onWorkspaceChanged();
    }
  }

  await state.update(DONE_KEY, true);

  const workspaceDir = server.workspace;

  let projects = [];
  try {
    projects = (await server.api('/api/fs/projects')).projects || [];
  } catch (err) {
    output.appendLine(`[er-studio] could not list projects: ${err.message}`);
    return { skipped: 'server unavailable' };
  }

  let projectName = projects[0] && projects[0].name;
  let created = false;

  if (!projectName) {
    const result = await offerStarterProject(server, output);
    if (!result) return { workspace: workspaceDir, skipped: 'declined' };

    if (!result.ok) {
      output.appendLine(`[er-studio] project creation failed: ${result.reason}`);
      vscode.window
        .showWarningMessage(
          `ER Studio could not create the project (${result.reason}). The environment doctor usually explains why.`,
          'Run Doctor',
          'Show Logs'
        )
        .then(choice => {
          if (choice === 'Run Doctor') vscode.commands.executeCommand('erStudio.doctor');
          if (choice === 'Show Logs') vscode.commands.executeCommand('erStudio.showLogs');
        });
      return { workspace: workspaceDir, failed: result.reason };
    }

    projectName = result.project;
    created = true;
  }

  if (onProjectReady) onProjectReady(projectName);

  if (config.get('openProjectOnStartup')) {
    await openEntryFile(path.join(workspaceDir, projectName), output);
  }

  if (created) {
    vscode.window
      .showInformationMessage(`"${projectName}" is ready. Run it on the simulator?`, 'Run', 'Not yet')
      .then(choice => {
        if (choice === 'Run') vscode.commands.executeCommand('erStudio.run');
      });
  }

  return { workspace: workspaceDir, project: projectName, created };
}

module.exports = { prepareWorkspace, findEntryFile, chooseWorkspace, countProjects };
