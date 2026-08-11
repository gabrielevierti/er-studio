// SDK detection - reports which Even Realities packages are installed.
//
// There is no per-platform install location to hunt for: these are npm
// packages. The global ones live under `npm root -g`, the project one under
// <project>/node_modules. One code path for macOS, Windows and Linux.
//
// Three versions matter and they can disagree:
//   evenhub-simulator   global    drives the automation API (RUN)
//   evenhub-cli         global    packages the .ehpk (PACK)
//   even_hub_sdk        project   what the user's code actually imports
//
// The third changes whenever the selected project changes, which is why the
// route takes a project name rather than reporting one global "SDK version".

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const express = require('express');

const GLOBAL_PACKAGES = {
  simulator: '@evenrealities/evenhub-simulator',
  cli: '@evenrealities/evenhub-cli'
};
const PROJECT_PACKAGE = '@evenrealities/even_hub_sdk';

const REGISTRY = 'https://registry.npmjs.org';
const DETECT_TTL_MS = 30_000;
const REGISTRY_TTL_MS = 6 * 60 * 60 * 1000;

let globalRootPromise = null;
let cache = { key: null, at: 0, value: null };
const registryCache = new Map();

/* ---------------- detection ---------------- */

// `npm root -g` is the only subprocess here and costs a few hundred ms, so it
// is resolved once per process and never on the status bar's path.
function globalRoot() {
  if (globalRootPromise) return globalRootPromise;
  globalRootPromise = new Promise(resolve => {
    execFile('npm', ['root', '-g'], { timeout: 8000 }, (err, stdout) => {
      resolve(err ? null : (stdout.trim() || null));
    });
  });
  return globalRootPromise;
}

// Reading package.json directly beats `npm ls`, which spawns a process and
// walks the tree for 0.5-2s to return the same number.
function readManifest(root, name) {
  try {
    const manifest = path.join(root, ...name.split('/'), 'package.json');
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version || null;
  } catch { return null; }
}

// npx caches packages under ~/.npm/_npx/<hash>/node_modules. proc.js falls back
// to `npx -y` when there is no global install, so a package found only here is
// a perfectly working setup - not an error. Reporting it as one would flag
// every user who never ran `npm i -g`.
function readNpxCache(name) {
  const cacheRoot = path.join(os.homedir(), '.npm', '_npx');
  let entries;
  try { entries = fs.readdirSync(cacheRoot); } catch { return null; }

  let best = null;
  for (const entry of entries) {
    const version = readManifest(path.join(cacheRoot, entry, 'node_modules'), name);
    if (version && (!best || compareVersions(version, best) > 0)) best = version;
  }
  return best;
}

function readInstalled(root, name) {
  const global = root ? readManifest(root, name) : null;
  if (global) return { name, version: global, source: 'global', found: true, reason: null };

  const npx = readNpxCache(name);
  if (npx) {
    return {
      name, version: npx, source: 'npx', found: true,
      reason: 'running from the npx cache - `npm i -g` is faster on first run'
    };
  }

  return {
    name, version: null, source: null, found: false,
    reason: root ? 'not installed, and not in the npx cache' : 'npm could not be located'
  };
}

function inspectProject(projectDir) {
  let declared = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    declared = (parsed.dependencies && parsed.dependencies[PROJECT_PACKAGE]) ||
               (parsed.devDependencies && parsed.devDependencies[PROJECT_PACKAGE]) || null;
  } catch {
    return { name: PROJECT_PACKAGE, declared: null, version: null, found: false,
             satisfies: null, reason: 'no readable package.json' };
  }

  const installed = readInstalled(path.join(projectDir, 'node_modules'), PROJECT_PACKAGE);

  return {
    name: PROJECT_PACKAGE,
    declared,
    version: installed.version,
    found: installed.found,
    satisfies: satisfiesRange(installed.version, declared),
    reason: installed.found ? null
      : declared ? 'declared in package.json but not installed - run npm install'
      : 'this project does not depend on the SDK'
  };
}

/* ---------------- update hints ---------------- */

// Failure is silent by design. An offline laptop or a proxy must never turn
// into an error banner - the versions above are still correct without this.
async function latestVersion(name) {
  const hit = registryCache.get(name);
  if (hit && Date.now() - hit.at < REGISTRY_TTL_MS) return hit.version;
  try {
    const res = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}/latest`,
                            { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const { version } = await res.json();
    registryCache.set(name, { version, at: Date.now() });
    return version || null;
  } catch { return null; }
}

async function attachUpdates(report) {
  const targets = [...Object.values(report.global), report.project].filter(e => e && e.found);
  await Promise.all(targets.map(async entry => {
    const latest = await latestVersion(entry.name);
    if (!latest) return;
    entry.latest = latest;
    entry.updateAvailable = compareVersions(latest, entry.version) > 0;
  }));
}

/* ---------------- version maths ---------------- */

function compareVersions(a, b) {
  if (!a || !b) return 0;
  const [aCore, aPre = ''] = String(a).split('-');
  const [bCore, bPre = ''] = String(b).split('-');
  const ap = aCore.split('.').map(Number);
  const bp = bCore.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const l = ap[i] || 0, r = bp[i] || 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  if (aPre === bPre) return 0;
  if (!aPre) return 1;          // a release beats a prerelease
  if (!bPre) return -1;
  return aPre > bPre ? 1 : -1;
}

// Returns null rather than guessing on git URLs, file: paths and compound
// ranges. A false mismatch warning trains people to ignore the badge.
function satisfiesRange(version, range) {
  if (!version || !range) return null;
  const cleaned = String(range).trim();
  if (cleaned === '*' || cleaned === 'latest') return true;

  const m = cleaned.match(/^([\^~]|>=)?\s*v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;

  const [, op, major, minor, patch] = m;
  const order = compareVersions(version, `${major}.${minor}.${patch}`);
  if (!op) return order === 0;
  if (op === '>=') return order >= 0;

  const inst = version.split('-')[0].split('.').map(Number);

  // ^0.x is the case that matters here: with a zero major, the MINOR is the
  // breaking-change axis, so ^0.7.0 does not accept 0.8.0. Every Even package
  // is still on 0.x, so this is the normal path, not an edge case.
  if (op === '^') {
    return Number(major) === 0
      ? inst[0] === 0 && inst[1] === Number(minor) && order >= 0
      : inst[0] === Number(major) && order >= 0;
  }
  return inst[0] === Number(major) && inst[1] === Number(minor) && order >= 0;
}

/* ---------------- router ---------------- */

function createSdkRouter(workspaceRoot) {
  const router = express.Router();

  // Same containment check as files.js - a project name is client input.
  function projectDir(name) {
    if (!name) return null;
    const abs = path.resolve(workspaceRoot, name);
    const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
    if (abs !== workspaceRoot && !abs.startsWith(rootWithSep)) return null;
    return fs.existsSync(abs) ? abs : null;
  }

  // GET /api/sdk?project=<name>&updates=1
  router.get('/', async (req, res) => {
    const project = req.query.project || '';
    const wantUpdates = req.query.updates === '1';
    const key = project;

    if (cache.key === key && Date.now() - cache.at < DETECT_TTL_MS && !wantUpdates) {
      return res.json(cache.value);
    }

    const root = await globalRoot();
    const report = { global: {}, project: null, globalRoot: root };

    for (const [key, name] of Object.entries(GLOBAL_PACKAGES)) {
      report.global[key] = root
        ? readInstalled(root, name)
        : { name, version: null, found: false, reason: 'npm global root not resolved' };
    }

    const dir = projectDir(project);
    if (dir) report.project = inspectProject(dir);

    cache = { key, at: Date.now(), value: report };

    if (wantUpdates) await attachUpdates(report);
    res.json(report);
  });

  return router;
}

function invalidate() { cache = { key: null, at: 0, value: null }; }

module.exports = { createSdkRouter, invalidate, compareVersions, satisfiesRange };