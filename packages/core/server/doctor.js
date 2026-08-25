// ER Studio - environment doctor
// One panel that answers "why doesn't this work yet?".
//
// Everything here is a *diagnosis*, not a stack trace. Each check returns a
// plain sentence and, when it fails, the exact command or link that fixes it.
// Rules the checks follow:
//
//   - a check never throws: a broken check reports itself as "could not
//     complete", it does not take the report down with it
//   - a check never blocks forever: everything that touches the disk, the
//     network or a subprocess has a timeout
//   - severity is about the user's goal, not about tidiness. Missing `dev`
//     script = fail (RUN is dead). Missing `build` script = warn (only PACK
//     cares). Anything cosmetic is a warn at most.
//
// The report is deliberately serialisable and boring: the UI renders it, the
// "copy report" button flattens it to text, and both use the same shape.

const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { execFile, spawn } = require('child_process');
const express = require('express');

const {
  globalRoot, readInstalled, inspectProject, latestVersion,
  compareVersions, GLOBAL_PACKAGES, PROJECT_PACKAGE
} = require('./sdk');
const { referenceHealth } = require('./sdkref');

/* ---------------- constants ---------------- */

const NODE_HARD_MIN = 18;        // ER Studio's own engines field
const NODE_DOC_MIN = 20;         // what Even's quickstart asks for
const SIM_AUTOMATION_MIN = '0.7.0';  // --automation-port, i.e. the live mirror

const INSTALL_TOOLING = 'npm i -g @evenrealities/evenhub-simulator @evenrealities/evenhub-cli';

const DOCS = {
  node: 'https://hub.evenrealities.com/docs/get-started/quickstart/install-node',
  tools: 'https://hub.evenrealities.com/docs/get-started/quickstart/install-tools',
  simulator: 'https://hub.evenrealities.com/docs/test/simulator',
  cli: 'https://hub.evenrealities.com/docs/reference/cli',
  packaging: 'https://hub.evenrealities.com/docs/ship/packaging',
  templates: 'https://hub.evenrealities.com/docs/get-started/quickstart/templates',
  erStudio: 'https://github.com/gabrielevierti/er-studio#getting-started',
  sdkChangelog: 'https://www.npmjs.com/package/@evenrealities/even_hub_sdk?activeTab=versions'
};

/* ---------------- small helpers ---------------- */

function execp(cmd, args, opts = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 4000, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve({
        err,
        code: err && typeof err.code === 'number' ? err.code : (err ? null : 0),
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim()
      });
    });
  });
}

// Resolve a binary against the PATH *this process will actually spawn with*.
// That is the whole point: a login shell may well find `node`, but if the
// Electron shell was launched from Finder with a stripped PATH, `npm run dev`
// will not. Walking process.env.PATH ourselves reports what RUN will see.
function whichOnPath(cmd) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? [cmd + '.cmd', cmd + '.exe', cmd] : [cmd];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* next */ }
    }
  }
  return null;
}

// Only consulted when whichOnPath fails, to tell "not installed at all" apart
// from "installed, but ER Studio cannot see it" - two very different fixes.
const SHELL_PROBE_ALLOWED = new Set(['node', 'npm', 'evenhub-simulator', 'evenhub', 'eh']);
async function loginShellWhich(cmd) {
  if (process.platform === 'win32') return null;
  if (!SHELL_PROBE_ALLOWED.has(cmd)) return null;   // never interpolate free text into a shell
  const shell = process.env.SHELL || '/bin/zsh';
  const { err, stdout } = await execp(shell, ['-lc', `command -v ${cmd}`], { timeout: 5000 });
  if (err || !stdout) return null;
  return stdout.split('\n')[0].trim() || null;
}

function tcpProbe(port, timeout = 700) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function majorOf(version) {
  const m = String(version || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function compareSemver(a, b) {
  const ap = String(a).split('-')[0].replace(/^v/, '').split('.').map(Number);
  const bp = String(b).split('-')[0].replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const l = ap[i] || 0, r = bp[i] || 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// `npm prefix -g` is one subprocess; the answer cannot change while we run.
let globalPrefixPromise = null;
function globalPrefix() {
  if (globalPrefixPromise) return globalPrefixPromise;
  globalPrefixPromise = execp('npm', ['prefix', '-g'], { timeout: 8000 })
    .then(({ err, stdout }) => (err ? null : stdout || null));
  return globalPrefixPromise;
}

function globalBinDir(prefix) {
  if (!prefix) return null;
  return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
}

/* ---------------- app.json validation ----------------
   The rules below are the documented evenhub pack schema. Validating them
   here means the failure arrives in one readable list before PACK runs,
   instead of one CLI error at a time.                                      */

const MANIFEST_REQUIRED = [
  'package_id', 'edition', 'name', 'version',
  'min_app_version', 'min_sdk_version', 'entrypoint',
  'permissions', 'supported_languages'
];
const MANIFEST_EDITION = '202601';
const PERMISSION_NAMES = new Set([
  'network', 'location', 'g2-microphone', 'phone-microphone', 'album', 'camera'
]);
const LANGUAGES = new Set(['en', 'de', 'fr', 'es', 'it', 'zh', 'ja', 'ko']);
const PACKAGE_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function validateManifest(manifest) {
  const problems = [];

  for (const field of MANIFEST_REQUIRED) {
    if (manifest[field] === undefined) problems.push(`"${field}" is missing (required)`);
  }

  if (typeof manifest.package_id === 'string' && !PACKAGE_ID_RE.test(manifest.package_id)) {
    problems.push(`"package_id" must be lowercase reverse-domain with at least two segments, no hyphens - got "${manifest.package_id}"`);
  }
  if (manifest.edition !== undefined && manifest.edition !== MANIFEST_EDITION) {
    problems.push(`"edition" must be "${MANIFEST_EDITION}" - got "${manifest.edition}"`);
  }
  if (typeof manifest.name === 'string' && manifest.name.length > 20) {
    problems.push(`"name" must be 20 characters or fewer - got ${manifest.name.length}`);
  }
  if (typeof manifest.version === 'string' && !SEMVER_RE.test(manifest.version)) {
    problems.push(`"version" must be x.y.z - got "${manifest.version}"`);
  }

  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions)) {
      problems.push('"permissions" must be an array of objects, not a key-value map');
    } else {
      manifest.permissions.forEach((perm, i) => {
        if (!perm || typeof perm !== 'object' || Array.isArray(perm)) {
          problems.push(`permissions[${i}] must be an object with "name" and "desc"`);
          return;
        }
        if (!PERMISSION_NAMES.has(perm.name)) {
          problems.push(`permissions[${i}].name "${perm.name}" is not one of: ${[...PERMISSION_NAMES].join(', ')}`);
        }
        if (typeof perm.desc !== 'string' || perm.desc.length < 1 || perm.desc.length > 300) {
          problems.push(`permissions[${i}].desc must be a string of 1-300 characters`);
        }
        if (perm.whitelist !== undefined && perm.name !== 'network') {
          problems.push(`permissions[${i}].whitelist only applies to the "network" permission`);
        }
      });
    }
  }

  if (manifest.supported_languages !== undefined) {
    if (!Array.isArray(manifest.supported_languages)) {
      problems.push('"supported_languages" must be an array of language codes');
    } else {
      for (const lang of manifest.supported_languages) {
        if (!LANGUAGES.has(lang)) {
          problems.push(`"${lang}" is not a supported language code (${[...LANGUAGES].join(', ')})`);
        }
      }
    }
  }

  return problems;
}

/* ---------------- checks ---------------- */

const CHECKS = [

  /* ---- host ---- */

  {
    id: 'os',
    group: 'Host',
    label: 'Operating system',
    run() {
      const described = `${os.type()} ${os.release()} (${os.arch()})`;
      if (process.platform === 'darwin') {
        return { status: 'pass', message: `macOS ${os.release()} on ${os.arch()}` };
      }
      return {
        status: 'warn',
        message: `${described} - partially supported`,
        detail: 'Editor, dev server, simulator control and packaging all work here. Hiding the simulator window and recapturing focus are macOS-only, so the simulator window will stay on screen next to ER Studio.',
        fix: {
          text: 'Nothing to install. Set "hideSimulator": false in ~/.er-studio.json to stop ER Studio trying.',
          url: DOCS.erStudio
        }
      };
    }
  },

  {
    id: 'node',
    group: 'Toolchain',
    label: 'Node.js',
    async run() {
      const embedded = process.versions.node;
      const underElectron = !!process.versions.electron;
      const embeddedNote = underElectron
        ? `ER Studio itself runs on Node ${embedded} bundled with Electron ${process.versions.electron}; your project runs on the Node below.`
        : null;

      const bin = whichOnPath('node');
      if (!bin) {
        const elsewhere = await loginShellWhich('node');
        if (elsewhere) {
          return {
            status: 'fail',
            message: 'Node is installed but not on the PATH ER Studio was launched with',
            detail: `Your login shell finds it at ${elsewhere}, but that directory is not in the PATH this process inherited, so RUN, PACK and NEW will all fail with "command not found". This is the classic Finder-launch PATH gap (nvm and fnm are the usual culprits, since they set PATH from your shell profile).`,
            fix: {
              text: 'Quickest fix: quit ER Studio and start it from a terminal instead, where your shell PATH is already set.',
              command: 'cd er-studio/er-studio && npm run app',
              url: DOCS.node
            }
          };
        }
        return {
          status: 'fail',
          message: 'Node.js not found',
          detail: 'Nothing in ER Studio that spawns a process can work without it: no dev server, no simulator, no packaging.',
          fix: { text: `Install Node ${NODE_DOC_MIN} LTS or newer, then restart ER Studio.`, url: DOCS.node }
        };
      }

      const { err, stdout } = await execp(bin, ['--version']);
      if (err) {
        return {
          status: 'fail',
          message: `Node was found at ${bin} but would not run`,
          detail: String(err.message || err),
          fix: { text: 'Reinstall Node, or remove the stale entry from your PATH.', url: DOCS.node }
        };
      }

      const version = stdout.replace(/^v/, '');
      const major = majorOf(version);

      if (major !== null && major < NODE_HARD_MIN) {
        return {
          status: 'fail',
          message: `Node ${version} is too old - ER Studio needs ${NODE_HARD_MIN}+`,
          detail: `Even's own toolchain asks for Node ${NODE_DOC_MIN} LTS or 22+. Resolved at ${bin}.`,
          fix: { text: `Install Node ${NODE_DOC_MIN} LTS or 22+, then restart ER Studio.`, url: DOCS.node }
        };
      }
      if (major !== null && major < NODE_DOC_MIN) {
        return {
          status: 'warn',
          message: `Node ${version} - below the ${NODE_DOC_MIN} LTS the Even Hub docs ask for`,
          detail: [`Resolved at ${bin}.`, 'ER Studio itself is fine with it; the SDK and templates are only tested on 20 LTS and 22+.', embeddedNote].filter(Boolean).join(' '),
          fix: { text: `Move to Node ${NODE_DOC_MIN} LTS or 22+ when convenient.`, url: DOCS.node }
        };
      }

      return {
        status: 'pass',
        message: `Node ${version}`,
        detail: [`Resolved at ${bin}.`, embeddedNote].filter(Boolean).join(' ')
      };
    }
  },

  {
    id: 'npm',
    group: 'Toolchain',
    label: 'npm',
    async run() {
      const bin = whichOnPath('npm');
      if (!bin) {
        const elsewhere = await loginShellWhich('npm');
        return {
          status: 'fail',
          message: elsewhere
            ? 'npm is installed but not on the PATH ER Studio was launched with'
            : 'npm not found',
          detail: elsewhere
            ? `Your login shell finds it at ${elsewhere}. Without it on this PATH, NEW (scaffold), RUN (npm run dev) and PACK (npm run build) all fail immediately.`
            : 'NEW, RUN and PACK all shell out to npm.',
          fix: { text: 'npm ships with Node - fixing the Node check above fixes this too.', url: DOCS.node }
        };
      }
      const { err, stdout } = await execp(bin, ['--version']);
      if (err) {
        return {
          status: 'fail',
          message: `npm was found at ${bin} but would not run`,
          detail: String(err.message || err),
          fix: { text: 'Reinstall Node (npm ships with it).', url: DOCS.node }
        };
      }
      return { status: 'pass', message: `npm ${stdout}`, detail: `Resolved at ${bin}.` };
    }
  },

  {
    id: 'path',
    group: 'Toolchain',
    label: 'npm global bin on PATH',
    async run() {
      if (!whichOnPath('npm')) {
        return { status: 'skip', message: 'Skipped - npm not available' };
      }
      const prefix = await globalPrefix();
      const binDir = globalBinDir(prefix);
      if (!binDir) {
        return {
          status: 'warn',
          message: 'Could not determine the npm global bin directory',
          detail: '`npm prefix -g` did not answer. Globally installed Even Hub tools may still work; ER Studio just cannot confirm where they live.',
          fix: { text: 'Run it yourself to see what happens.', command: 'npm prefix -g' }
        };
      }

      const onPath = String(process.env.PATH || '')
        .split(path.delimiter)
        .some(entry => path.resolve(entry) === path.resolve(binDir));

      if (onPath) {
        return { status: 'pass', message: `${binDir} is on PATH` };
      }

      // Does it actually matter here? Only if something is installed in there.
      let installedThere = [];
      try {
        installedThere = fs.readdirSync(binDir).filter(f => /^(evenhub|eh)(-|$)/.test(f));
      } catch { /* directory may not exist yet */ }

      if (installedThere.length > 0) {
        return {
          status: 'fail',
          message: 'Global npm binaries are installed but not on PATH',
          detail: `${binDir} holds ${installedThere.join(', ')} but is not in the PATH ER Studio inherited. ER Studio silently falls back to "npx -y", which downloads on first use, is much slower, and can resolve a different version than the one you installed.`,
          fix: {
            text: 'Add the npm global bin directory to your shell profile, then relaunch ER Studio.',
            command: `echo 'export PATH="${binDir}:$PATH"' >> ~/.zshrc`,
            url: DOCS.node
          }
        };
      }

      return {
        status: 'warn',
        message: 'npm global bin directory is not on PATH',
        detail: `${binDir} is not in PATH. Nothing is installed there yet, so nothing is broken - but a later "npm i -g" will appear to do nothing.`,
        fix: {
          text: 'Add it to your shell profile before installing the Even Hub tooling globally.',
          command: `echo 'export PATH="${binDir}:$PATH"' >> ~/.zshrc`,
          url: DOCS.node
        }
      };
    }
  },

  /* ---- even hub tooling ---- */

  {
    id: 'simulator',
    group: 'Even Hub tooling',
    label: 'Simulator package',
    async run() {
      const root = await globalRoot();
      const entry = readInstalled(root, GLOBAL_PACKAGES.simulator);

      if (!entry.found) {
        return {
          status: 'fail',
          message: 'evenhub-simulator is not installed',
          detail: `${entry.reason}. RUN starts the dev server and then stops: there is no simulator to launch, so the glasses mirror stays dark.`,
          fix: { text: 'Install the Even Hub tooling globally.', command: INSTALL_TOOLING, url: DOCS.tools, auto: true }
        };
      }

      if (compareSemver(entry.version, SIM_AUTOMATION_MIN) < 0) {
        return {
          status: 'fail',
          message: `evenhub-simulator ${entry.version} is too old - needs ${SIM_AUTOMATION_MIN}+`,
          detail: `The live mirror, the TouchBar pad, the simulator console and every metric are built on the HTTP automation control plane, which arrived in ${SIM_AUTOMATION_MIN}. On ${entry.version} the simulator launches but ER Studio can see nothing inside it.`,
          fix: { text: 'Upgrade the simulator.', command: 'npm i -g @evenrealities/evenhub-simulator@latest', url: DOCS.simulator, auto: true }
        };
      }

      if (entry.source === 'npx') {
        return {
          status: 'warn',
          message: `evenhub-simulator ${entry.version} - resolved from the npx cache`,
          detail: 'This works. It just costs a cold start on every first RUN, and npx may quietly pick a different version than you expect.',
          fix: { text: 'Install it globally to make RUN start immediately.', command: INSTALL_TOOLING, url: DOCS.tools, auto: true }
        };
      }

      return { status: 'pass', message: `evenhub-simulator ${entry.version}`, detail: `Installed globally under ${root}.` };
    }
  },

  {
    id: 'simulator-launch',
    group: 'Even Hub tooling',
    label: 'Simulator launches',
    async run() {
      const bin = whichOnPath('evenhub-simulator');
      if (!bin) {
        return {
          status: 'skip',
          message: 'Skipped - no evenhub-simulator binary on PATH to probe',
          detail: 'ER Studio would fall back to "npx -y" at RUN time, which cannot be probed without downloading the package first.'
        };
      }

      // -V prints the version and exits; documented, and it never opens a
      // window. Detached + group kill anyway, so a hang cannot leave a stray
      // GUI process behind.
      const probe = await new Promise(resolve => {
        let child;
        try {
          child = spawn(bin, ['--version'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (err) {
          return resolve({ outcome: 'spawn-error', message: String(err.message || err) });
        }
        let out = '';
        let settled = false;
        const finish = result => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
          finish({ outcome: 'timeout' });
        }, 4000);

        child.stdout.on('data', d => { out += d.toString('utf8'); });
        child.stderr.on('data', d => { out += d.toString('utf8'); });
        child.on('error', err => finish({ outcome: 'spawn-error', message: String(err.message || err) }));
        child.on('exit', code => finish({ outcome: 'exit', code, out: out.trim() }));
      });

      if (probe.outcome === 'spawn-error') {
        return {
          status: 'fail',
          message: 'The simulator binary is present but will not start',
          detail: `${bin} - ${probe.message}. On macOS this is usually Gatekeeper quarantine on a downloaded binary, or a missing execute bit.`,
          fix: { text: 'Reinstall it; if macOS blocked it, clear the quarantine flag.', command: `xattr -d com.apple.quarantine "${bin}" 2>/dev/null; npm i -g @evenrealities/evenhub-simulator@latest`, url: DOCS.simulator }
        };
      }
      if (probe.outcome === 'timeout') {
        return {
          status: 'warn',
          message: 'The simulator did not answer --version within 4s',
          detail: 'Not necessarily broken - a cold first start on a slow disk looks exactly like this. If RUN also hangs with a blank mirror, this is where to look.',
          fix: { text: 'Try it by hand and watch what it prints.', command: 'evenhub-simulator --version', url: DOCS.simulator }
        };
      }
      if (probe.code !== 0) {
        return {
          status: 'warn',
          message: `The simulator exited with code ${probe.code} on --version`,
          detail: probe.out ? probe.out.split('\n').slice(0, 4).join(' ') : 'No output.',
          fix: { text: 'Run it by hand to see the full message.', command: 'evenhub-simulator --version', url: DOCS.simulator }
        };
      }
      return {
        status: 'pass',
        message: `Launches cleanly${probe.out ? ` - reports ${probe.out.split('\n')[0]}` : ''}`,
        detail: `Probed ${bin} with --version.`
      };
    }
  },

  {
    id: 'cli',
    group: 'Even Hub tooling',
    label: 'Packaging CLI',
    async run() {
      const root = await globalRoot();
      const entry = readInstalled(root, GLOBAL_PACKAGES.cli);
      // The package is @evenrealities/evenhub-cli, but the binaries it installs
      // are `evenhub` and the `eh` alias - there is no `evenhub-cli` on PATH.
      const binaries = ['evenhub', 'eh', 'evenhub-cli']
        .map(name => ({ name, at: whichOnPath(name) }))
        .filter(b => b.at);

      if (!entry.found) {
        return {
          status: 'warn',
          message: 'evenhub-cli is not installed',
          detail: 'Only PACK needs it. ER Studio falls back to "npx -y @evenrealities/evenhub-cli", so packaging still works - it just downloads the CLI the first time you press PACK.',
          fix: { text: 'Install it globally for instant, offline packaging.', command: INSTALL_TOOLING, url: DOCS.cli, auto: true }
        };
      }

      if (binaries.length === 0) {
        return {
          status: 'warn',
          message: `evenhub-cli ${entry.version} is installed but no CLI binary is on PATH`,
          detail: 'The package installs `evenhub` (and the `eh` alias). Neither is visible on this PATH, so PACK will take the slow npx route.',
          fix: { text: 'See the "npm global bin on PATH" check above.', url: DOCS.cli }
        };
      }

      return {
        status: 'pass',
        message: `evenhub-cli ${entry.version}`,
        detail: `Callable as ${binaries.map(b => b.name).join(', ')}.`
      };
    }
  },

  {
    id: 'automation-port',
    group: 'Even Hub tooling',
    label: 'Automation port',
    async run(ctx) {
      const port = ctx.simAutomationPort;
      const open = await tcpProbe(port);
      if (!open) {
        return { status: 'pass', message: `Port ${port} is free`, detail: 'The simulator will get the control plane it needs on the next RUN.' };
      }

      // Something is listening. Ours, or a squatter?
      let isSimulator = false;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
        const body = (await res.text()).trim().toLowerCase();
        isSimulator = res.ok && body.includes('pong');
      } catch { /* not a simulator, or not speaking HTTP */ }

      if (isSimulator) {
        return {
          status: 'pass',
          message: `A simulator control plane is answering on ${port}`,
          detail: ctx.running
            ? 'That is this session - exactly as expected.'
            : 'ER Studio is not running a session, so this is a simulator left over from a previous run. RUN will reuse the port and may end up mirroring the old process.',
          fix: ctx.running ? undefined : {
            text: 'Kill the leftover simulator before the next RUN.',
            command: `lsof -ti tcp:${port} | xargs kill`
          }
        };
      }

      return {
        status: 'fail',
        message: `Port ${port} is taken by something that is not the simulator`,
        detail: 'The simulator will fail to bind its control plane, so RUN produces a live simulator window with a permanently dark mirror, an empty console and no metrics - with no error to explain it.',
        fix: {
          text: 'Find what is holding the port and stop it.',
          command: `lsof -i tcp:${port}`
        }
      };
    }
  },

  {
    id: 'registry',
    group: 'Even Hub tooling',
    label: 'npm registry reachable',
    async run() {
      try {
        const res = await fetch('https://registry.npmjs.org/@evenrealities%2Fevenhub-simulator/latest',
          { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { version } = await res.json();
        return { status: 'pass', message: `Reachable - latest simulator is ${version}` };
      } catch (err) {
        return {
          status: 'warn',
          message: 'npm registry not reachable',
          detail: `Offline, or a proxy is in the way (${String(err.message || err)}). Everything already installed keeps working; you just lose update hints, and NEW / npx fallbacks will fail until you are back online.`,
          fix: { text: 'No action needed if you are working offline on purpose.' }
        };
      }
    }
  },

  /* ---- er studio itself ---- */

  {
    id: 'config',
    group: 'ER Studio',
    label: 'User config',
    run(ctx) {
      const file = path.join(os.homedir(), '.er-studio.json');
      if (!fs.existsSync(file)) {
        return {
          status: 'pass',
          message: 'No config file - using defaults',
          detail: `Workspace defaults to ${path.join(os.homedir(), 'er-workspace')}.`,
          fix: {
            text: 'Create ~/.er-studio.json to point ER Studio at your own projects folder.',
            command: `printf '{\\n  "workspace": "%s/dev/even-projects",\\n  "hideSimulator": true\\n}\\n' "$HOME" > ~/.er-studio.json`,
            url: DOCS.erStudio
          }
        };
      }

      let cfg;
      try {
        cfg = readJson(file);
      } catch (err) {
        return {
          status: 'fail',
          message: '~/.er-studio.json is not valid JSON',
          detail: `${String(err.message || err)} - the whole file is ignored, so ER Studio silently fell back to its defaults and your projects folder looks empty.`,
          fix: { text: 'Fix the syntax (a trailing comma is the usual cause), then restart ER Studio.', command: 'cat ~/.er-studio.json' }
        };
      }

      if (cfg.workspace && path.resolve(cfg.workspace) !== path.resolve(ctx.workspace)) {
        return {
          status: 'fail',
          message: 'The configured workspace is not the one in use',
          detail: `Config asks for ${cfg.workspace}; ER Studio is using ${ctx.workspace}. The configured path did not exist at startup, so it was not used.`,
          fix: { text: 'Correct the path in ~/.er-studio.json, or create the folder, then restart ER Studio.', command: `mkdir -p "${cfg.workspace}"`, auto: true }
        };
      }

      return { status: 'pass', message: 'Config file read', detail: `${file} - workspace ${ctx.workspace}.` };
    }
  },

  {
    id: 'workspace',
    group: 'ER Studio',
    label: 'Workspace folder',
    run(ctx) {
      if (!fs.existsSync(ctx.workspace)) {
        return {
          status: 'fail',
          message: 'The workspace folder does not exist',
          detail: ctx.workspace,
          fix: { text: 'Create it and restart ER Studio.', command: `mkdir -p "${ctx.workspace}"`, auto: true }
        };
      }
      try {
        fs.accessSync(ctx.workspace, fs.constants.W_OK);
      } catch {
        return {
          status: 'fail',
          message: 'The workspace folder is not writable',
          detail: `${ctx.workspace} - saving files, scaffolding and packing will all fail.`,
          fix: { text: 'Fix the permissions.', command: `chmod u+rwx "${ctx.workspace}"` }
        };
      }

      let projects = 0;
      try {
        projects = fs.readdirSync(ctx.workspace, { withFileTypes: true })
          .filter(e => e.isDirectory() && fs.existsSync(path.join(ctx.workspace, e.name, 'package.json')))
          .length;
      } catch { /* counted as zero */ }

      if (projects === 0) {
        return {
          status: 'warn',
          message: 'Workspace is writable but holds no projects',
          detail: `${ctx.workspace} contains no folder with a package.json, so the PROJECT dropdown is empty.`,
          fix: { text: 'Press NEW to scaffold one from the official templates.', url: DOCS.templates }
        };
      }

      return { status: 'pass', message: `${projects} project${projects === 1 ? '' : 's'}`, detail: ctx.workspace };
    }
  },

  {
    id: 'terminal',
    group: 'ER Studio',
    label: 'Integrated terminal',
    run(ctx) {
      if (ctx.hasPty) return { status: 'pass', message: 'node-pty loaded - full interactive shell' };

      // Under the VS Code extension there is no ER Studio terminal at all - the
      // editor has its own, which is the better one. Warning about a missing
      // native module for a panel that is not shipped is noise, so this only
      // matters in browser mode.
      if (ctx.host === 'vscode') {
        return {
          status: 'skip',
          message: 'Not applicable - VS Code provides the terminal',
          detail: 'ER Studio does not ship its own terminal panel in the extension, so node-pty is not needed.'
        };
      }

      return {
        status: 'warn',
        message: 'Running the fallback command runner',
        detail: 'node-pty did not load, so the TERMINAL panel takes one command per line with no interactive programs, no arrow keys and no history. Everything else in ER Studio is unaffected.',
        fix: {
          text: 'Rebuild node-pty against your Node version, then restart ER Studio.',
          command: 'chmod +x node_modules/node-pty/build/Release/spawn-helper && npm rebuild node-pty',
          url: DOCS.erStudio
        }
      };
    }
  },

  {
    id: 'automation-permission',
    group: 'ER Studio',
    label: 'Window control permission',
    async run() {
      if (process.platform !== 'darwin') {
        return { status: 'skip', message: 'Skipped - macOS only' };
      }
      // Read-only AppleScript. The first run triggers the one-time consent
      // dialog, which is the point: better here, with an explanation, than
      // silently mid-RUN when the simulator steals focus.
      const { err, stderr } = await execp('osascript',
        ['-e', 'tell application "System Events" to get name of first process'],
        { timeout: 6000 });

      if (!err) return { status: 'pass', message: 'ER Studio may control System Events' };

      const text = String(stderr || err.message || '');
      if (/not allowed|-1743|assistive|not authorized/i.test(text)) {
        return {
          status: 'warn',
          message: 'Not allowed to control System Events',
          detail: 'This is how ER Studio hides the simulator window and takes focus back. Without it the simulator window stays in front of you on every RUN. Nothing else breaks.',
          fix: {
            text: 'Grant it in System Settings > Privacy & Security > Automation (and Accessibility), then restart ER Studio.',
            command: 'open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"'
          }
        };
      }
      return {
        status: 'warn',
        message: 'Could not confirm the permission',
        detail: text.split('\n')[0] || 'osascript did not answer.',
        fix: { text: 'Only affects hiding the simulator window.' }
      };
    }
  },

  /* ---- selected project ---- */

  {
    id: 'project-package',
    group: 'Project',
    label: 'package.json',
    run(ctx) {
      if (!ctx.projectDir) return { status: 'skip', message: 'Skipped - no project selected' };
      const file = path.join(ctx.projectDir, 'package.json');
      let pkg;
      try {
        pkg = readJson(file);
      } catch (err) {
        return {
          status: 'fail',
          message: 'package.json is missing or unreadable',
          detail: String(err.message || err),
          fix: { text: 'Scaffold a fresh project with NEW, or restore the file.', url: DOCS.templates }
        };
      }

      const scripts = pkg.scripts || {};
      if (!scripts.dev) {
        return {
          status: 'fail',
          message: 'No "dev" script',
          detail: 'RUN executes `npm run dev` and reads the Vite URL from its output. Without that script the session dies immediately and the simulator never launches.',
          fix: { text: 'Add a dev script (Vite projects use `vite`).', command: `cd "${ctx.projectDir}" && npm pkg set scripts.dev="vite"`, url: DOCS.templates, auto: true }
        };
      }
      if (!scripts.build) {
        return {
          status: 'warn',
          message: 'No "build" script',
          detail: 'RUN is fine. PACK runs `npm run build` before `evenhub pack`, so packaging will fail at the first step.',
          fix: { text: 'Add a build script.', command: `cd "${ctx.projectDir}" && npm pkg set scripts.build="vite build"`, url: DOCS.packaging, auto: true }
        };
      }
      return { status: 'pass', message: `${pkg.name || ctx.project} - dev and build scripts present` };
    }
  },

  {
    id: 'project-reference',
    group: 'Project',
    label: 'SDK API reference',
    run(ctx) {
      const h = referenceHealth(ctx.projectDir);

      if (!h.version) {
        return {
          status: 'warn',
          message: 'No API reference available',
          detail: `${h.reason || 'unknown'}. The REFERENCE panel will be empty.`,
          fix: { text: 'Select a project with the SDK installed, or rebuild the offline snapshot.', command: 'node tools/build-sdk-reference.js' }
        };
      }

      const missing = (h.symbolsWithoutEnglish || []).length;

      if (h.unparsedExports && h.unparsedExports.length) {
        return {
          status: 'warn',
          message: `${h.unparsedExports.length} exported symbol(s) not parsed`,
          detail: `The .d.ts shape changed in SDK ${h.version} and server/dts-parse.js did not recognise: ${h.unparsedExports.join(', ')}. Those symbols are missing from the REFERENCE panel.`,
          fix: { text: 'Extend the parser, or switch it to the TypeScript compiler API.' }
        };
      }

      // The overlay lagging the SDK is now the normal state of the world, not
      // a fault: signatures come from whatever SDK is in play (installed, or
      // the latest pulled from the registry), while the English notes are
      // written by hand and catch up afterwards. So this passes with a note -
      // it used to warn, which meant the panel cried wolf on the morning of
      // every Even release.
      if (h.overlayStale) {
        const orphans = (h.orphanedOverlayEntries || []).length;
        return {
          status: 'pass',
          message: `${h.symbolCount} symbols from SDK ${h.version} - English notes written for ${h.overlayAuthoredAgainst || 'an older release'}`,
          detail: `Signatures, parameters and types come from SDK ${h.version} and are current. ${orphans ? `${orphans} overlay entr${orphans === 1 ? 'y refers' : 'ies refer'} to symbols that no longer exist. ` : ''}Only the hand-written English summaries may lag.`,
          fix: {
            text: 'Optional: refresh the offline snapshot and the notes.',
            command: 'node tools/build-sdk-reference.js'
          }
        };
      }

      return {
        status: 'pass',
        message: `${h.symbolCount} symbols from SDK ${h.version}${
          h.source === 'bundled' ? ' (bundled snapshot)'
          : h.source === 'registry' ? ' (latest published)' : ''}`,
        detail: missing
          ? `${missing} symbols have no English overlay entry yet and fall back to the SDK's original Chinese doc comments.`
          : null
      };
    }
  },

  {
    id: 'project-deps',
    group: 'Project',
    label: 'Dependencies installed',
    run(ctx) {
      if (!ctx.projectDir) return { status: 'skip', message: 'Skipped - no project selected' };
      const modules = path.join(ctx.projectDir, 'node_modules');
      let count = 0;
      try {
        count = fs.readdirSync(modules).length;
      } catch { /* missing */ }

      if (count === 0) {
        return {
          status: 'fail',
          message: 'node_modules is missing or empty',
          detail: 'RUN will fail as soon as Vite is invoked. This is normal right after cloning a project that was not scaffolded through NEW.',
          fix: { text: 'Install the dependencies.', command: `cd "${ctx.projectDir}" && npm install`, auto: true }
        };
      }
      return { status: 'pass', message: `${count} package${count === 1 ? '' : 's'} installed` };
    }
  },

  {
    id: 'project-sdk',
    group: 'Project',
    label: 'Even Hub SDK',
    async run(ctx) {
      if (!ctx.projectDir) return { status: 'skip', message: 'Skipped - no project selected' };
      const sdk = inspectProject(ctx.projectDir);

      const installLatest = `cd "${ctx.projectDir}" && npm i ${PROJECT_PACKAGE}@latest`;

      if (!sdk.declared && !sdk.found) {
        return {
          status: 'warn',
          message: 'This project does not depend on the Even Hub SDK',
          detail: 'Fine for a plain web page, but nothing will render on the glasses without it.',
          fix: { text: 'Add the SDK.', command: `cd "${ctx.projectDir}" && npm i ${PROJECT_PACKAGE}`, url: DOCS.tools, auto: true }
        };
      }
      if (sdk.declared && !sdk.found) {
        return {
          status: 'fail',
          message: `SDK ${sdk.declared} is declared but not installed`,
          detail: 'Imports resolve to nothing and Vite fails at the first import of the SDK.',
          fix: { text: 'Install it.', command: `cd "${ctx.projectDir}" && npm install`, auto: true }
        };
      }
      if (sdk.satisfies === false) {
        return {
          status: 'warn',
          message: `SDK ${sdk.version} does not satisfy ${sdk.declared}`,
          detail: 'npm would not have chosen this version for that range, so it was almost certainly installed by hand or left behind by an edit to package.json.',
          fix: { text: 'Reinstall to bring it in line.', command: `cd "${ctx.projectDir}" && npm install`, auto: true }
        };
      }

      // Registry lookup. latestVersion caches for 6 hours and returns null on
      // failure, so an offline laptop degrades to the old behaviour rather
      // than turning into a warning about nothing.
      const latest = await latestVersion(PROJECT_PACKAGE);

      if (!latest) {
        return {
          status: 'pass',
          message: `even_hub_sdk ${sdk.version}`,
          detail: [
            sdk.declared ? `package.json declares ${sdk.declared}.` : null,
            'Could not reach the npm registry, so this may not be the newest release.'
          ].filter(Boolean).join(' ')
        };
      }

      const delta = compareVersions(latest, sdk.version);

      if (delta > 0) {
        // ^0.0.x pins the patch in npm's resolver, so `npm update` is a no-op
        // here. Saying so is the difference between a useful warning and one
        // that sends people round in circles.
        const caretPinned = /^\^0\.0\./.test(String(sdk.declared || ''));
        return {
          status: 'warn',
          message: `even_hub_sdk ${sdk.version} - ${latest} is available`,
          detail: [
            sdk.declared ? `package.json declares ${sdk.declared}.` : null,
            caretPinned
              ? '"npm update" will not move this: npm resolves ^0.0.x to exactly 0.0.x, so the range is pinned until you install the new version explicitly.'
              : null,
            'Even has been releasing roughly monthly; check the version list before upgrading a project mid-flight.'
          ].filter(Boolean).join(' '),
          fix: {
            text: 'Install the latest release, which also rewrites the range in package.json.',
            command: installLatest,
            url: DOCS.sdkChangelog,
            auto: 'confirm'
          }
        };
      }

      if (delta < 0) {
        return {
          status: 'pass',
          message: `even_hub_sdk ${sdk.version} - ahead of the published ${latest}`,
          detail: 'A prerelease, a link, or a local build. Nothing to do unless that is a surprise.'
        };
      }

      return {
        status: 'pass',
        message: `even_hub_sdk ${sdk.version} - latest`,
        detail: sdk.declared ? `package.json declares ${sdk.declared}.` : undefined
      };
    }
  },

  {
    id: 'project-manifest',
    group: 'Project',
    label: 'app.json manifest',
    run(ctx) {
      if (!ctx.projectDir) return { status: 'skip', message: 'Skipped - no project selected' };
      const file = path.join(ctx.projectDir, 'app.json');

      if (!fs.existsSync(file)) {
        return {
          status: 'warn',
          message: 'No app.json',
          detail: 'RUN does not need it. PACK does - it is the first argument to `evenhub pack`, and without it you cannot produce an .ehpk or submit anything.',
          fix: { text: 'Generate a starter manifest in the project folder.', command: `cd "${ctx.projectDir}" && npx -y @evenrealities/evenhub-cli init`, url: DOCS.packaging, auto: true }
        };
      }

      let manifest;
      try {
        manifest = readJson(file);
      } catch (err) {
        return {
          status: 'fail',
          message: 'app.json is not valid JSON',
          detail: String(err.message || err),
          fix: { text: 'Fix the syntax - PACK cannot read it at all in this state.', url: DOCS.packaging }
        };
      }

      const problems = validateManifest(manifest);

      // The entrypoint must exist inside the built output, not the source tree.
      const buildDir = ['dist', 'build'].map(d => path.join(ctx.projectDir, d)).find(d => fs.existsSync(d));
      let entrypointNote;
      if (typeof manifest.entrypoint === 'string' && buildDir) {
        if (!fs.existsSync(path.join(buildDir, manifest.entrypoint))) {
          problems.push(`entrypoint "${manifest.entrypoint}" does not exist in ${path.basename(buildDir)}/ - pack will fail with "Entrypoint file not found"`);
        }
      } else if (typeof manifest.entrypoint === 'string') {
        entrypointNote = `Not built yet, so "${manifest.entrypoint}" could not be verified against the output folder.`;
      }

      if (problems.length > 0) {
        return {
          status: 'fail',
          message: `${problems.length} problem${problems.length === 1 ? '' : 's'} in app.json`,
          detail: problems.map(p => '- ' + p).join('\n'),
          fix: { text: 'Each line above maps to a documented evenhub pack validation rule.', url: DOCS.packaging }
        };
      }

      return {
        status: 'pass',
        message: `Valid - ${manifest.package_id} v${manifest.version}`,
        detail: entrypointNote
      };
    }
  }
];

/* ---------------- runner ---------------- */

const CHECK_TIMEOUT_MS = 15000;

// A check that throws or hangs becomes a warn with its message in the detail -
// never a stack trace as the headline, and never a report that fails to render.
async function runOne(check, ctx) {
  const started = Date.now();
  let result;
  try {
    result = await Promise.race([
      Promise.resolve(check.run(ctx)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('check timed out')), CHECK_TIMEOUT_MS))
    ]);
  } catch (err) {
    result = {
      status: 'warn',
      message: 'This check could not complete',
      detail: String((err && err.message) || err),
      fix: { text: 'Re-run it; if it keeps failing, include this report in a bug report.' }
    };
  }
  return {
    id: check.id,
    group: check.group,
    label: check.label,
    status: result.status,
    message: result.message,
    detail: result.detail || null,
    fix: result.fix || null,
    ms: Date.now() - started
  };
}

async function runChecks(ctx, only = []) {
  const selected = only.length ? CHECKS.filter(c => only.includes(c.id)) : CHECKS;
  const results = await Promise.all(selected.map(check => runOne(check, ctx)));

  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) summary[r.status] = (summary[r.status] || 0) + 1;

  return {
    generatedAt: new Date().toISOString(),
    partial: only.length > 0,
    env: {
      erStudio: ctx.appVersion,
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      node: process.versions.node,
      electron: process.versions.electron || null,
      project: ctx.project || null,
      workspace: ctx.workspace,
      // Sent so the UI can redact it out of the copied report - people paste
      // these into Discord, and a home path carries a real name more often
      // than not.
      home: os.homedir()
    },
    summary,
    checks: results
  };
}

/* ---------------- auto-fix resolution ----------------
   A fix is only ever run automatically when the check that produced it marked
   it `auto: true`. That flag means: idempotent, reversible, scoped to the npm
   prefix or the selected project, and safe to run without reading first.
   Everything else - permission changes, quarantine flags, version bumps that
   rewrite a range mid-project, anything that stops a running process - stays
   MANUAL and is only ever copied to the clipboard.                          */

function isAutoFix(check) {
  return !!(check.fix && (check.fix.auto === true || check.fix.auto === 'confirm') && check.fix.command &&
            check.status !== 'pass' && check.status !== 'skip');
}

// Same containment rule as files.js and sdk.js: a project name is client input.
function resolveProjectDir(workspace, name) {
  if (!name) return null;
  const abs = path.resolve(workspace, name);
  const rootWithSep = workspace.endsWith(path.sep) ? workspace : workspace + path.sep;
  if (abs !== workspace && !abs.startsWith(rootWithSep)) return null;
  return fs.existsSync(abs) ? abs : null;
}

// The UI posts check *ids*, never commands. We re-run those checks here and
// take the commands from the fresh result, so a stale panel cannot run a fix
// for a problem that has since been solved, and nothing the client sends can
// widen into arbitrary shell.
async function resolveAutoFixes(base, ids, project) {
  const only = (Array.isArray(ids) ? ids : [])
    .map(String)
    .filter(id => CHECKS.some(c => c.id === id));

  if (!only.length) return { commands: [], checks: [], report: null };

  const report = await runChecks({
    ...base,
    project: project || null,
    projectDir: resolveProjectDir(base.workspace, project),
    running: base.procman ? base.procman.publicState().running : false
  }, only);

  const runnable = report.checks.filter(isAutoFix);
  // Two checks often propose the same install line; run it once.
  const commands = [...new Set(runnable.map(c => c.fix.command))];
  return { commands, checks: runnable, report };
}

/* ---------------- router ---------------- */

function createDoctorRouter(base) {
  const router = express.Router();

  const projectDir = name => resolveProjectDir(base.workspace, name);

  // GET /api/doctor?project=<name>&only=<id,id>
  router.get('/', async (req, res) => {
    const project = String(req.query.project || '');
    const only = String(req.query.only || '')
      .split(',')
      .map(s => s.trim())
      .filter(id => CHECKS.some(c => c.id === id));   // allowlist, not free text

    try {
      const report = await runChecks({
        ...base,
        project: project || null,
        projectDir: projectDir(project),
        running: base.procman ? base.procman.publicState().running : false
      }, only);
      res.json(report);
    } catch (err) {
      // Should be unreachable - runOne already swallows per-check failures.
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // GET /api/doctor/checks - ids and labels, for a UI that wants to render
  // the rows before the first run completes.
  router.get('/checks', (req, res) => {
    res.json({ checks: CHECKS.map(({ id, group, label }) => ({ id, group, label })) });
  });

  return router;
}

module.exports = {
  createDoctorRouter, runChecks, validateManifest, CHECKS,
  resolveAutoFixes, isAutoFix, resolveProjectDir
};
