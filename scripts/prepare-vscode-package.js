#!/usr/bin/env node
// Build apps/vscode/er-studio-<version>.vsix as a complete, self-contained package.
//
// Why this exists: `vsce package` cannot run correctly inside this repo, because
// this repo is an npm workspace, and vsce shells out to `npm list --production`
// to decide which node_modules to include. Inside the workspace that command
// either resolves paths outside the extension folder (vsce then refuses to
// package: "invalid relative path: extension/../../package.json"), or - if you
// hand-copy express/ws into apps/vscode/node_modules to dodge that - `npm list`
// sees files with no matching lockfile entry and reports them as "extraneous"/
// "invalid", which vsce also treats as fatal.
//
// A previous version of this script tried to route around this by hand-copying
// express/ws into apps/vscode/node_modules and passing --no-dependencies to skip
// vsce's dependency check entirely. That flag does not mean "trust what's on
// disk" - in current @vscode/vsce it means "do not package node_modules AT ALL".
// The result was a .vsix that installs and activates fine, but throws
// `Cannot find module 'express'` the moment anything touches the local server -
// which is every command and every webview panel, so the extension looks
// completely broken with no visible error.
//
// The fix: never run vsce, or even `npm install`, inside this workspace for
// packaging. Stage a standalone copy of apps/vscode in a scratch directory that
// has no workspaces-aware package.json anywhere above it, run a completely
// ordinary `npm install --omit=dev` there (so npm's own bookkeeping is clean),
// then run plain `vsce package` there. Copy the resulting .vsix back.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'apps', 'vscode');
const CORE_SRC = path.join(ROOT, 'packages', 'core');
const CORE_DST = path.join(EXT, 'core');

const SKIP_ENTRIES = new Set(['node_modules', '.git', '.DS_Store', '.bin']);

function copyDir(from, to, skip = SKIP_ENTRIES) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst, skip);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
    // Symlinks are skipped: following them is how an earlier version of this
    // script walked into itself.
  }
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n++;
  }
  return n;
}

function vendorCore() {
  if (!fs.existsSync(path.join(EXT, 'media', 'icon.png'))) {
    console.error('[prepare] missing apps/vscode/media/icon.png - vsce requires a 128x128 icon');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(CORE_SRC, 'package.json'))) {
    console.error('[prepare] packages/core not found - run this from the repo root');
    process.exit(1);
  }

  fs.rmSync(CORE_DST, { recursive: true, force: true });
  copyDir(CORE_SRC, CORE_DST);
  console.log(`[prepare] vendored packages/core -> apps/vscode/core (${countFiles(CORE_DST)} files)`);
  // Also keep a local copy so `require('../core')` works when running the
  // extension straight from this checkout (F5 / Extension Development Host)
  // without a full package step.
}

function buildOutsideWorkspace() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'er-studio-vsce-'));
  const dst = path.join(scratch, 'er-studio');

  // Everything except node_modules and any local .vsix from a previous build.
  copyDir(EXT, dst, new Set(['node_modules', '.git', '.DS_Store']));
  for (const f of fs.readdirSync(dst)) {
    if (f.endsWith('.vsix')) fs.rmSync(path.join(dst, f));
  }
  console.log(`[prepare] staged extension outside the workspace at ${dst}`);

  console.log('[prepare] npm install --omit=dev (clean, standalone - no workspace above this folder)...');
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dst, stdio: 'inherit' });

  console.log('[prepare] npm install -D @vscode/vsce (packaging tool only, not shipped)...');
  execFileSync('npm', ['install', '-D', '@vscode/vsce', '--no-audit', '--no-fund'], { cwd: dst, stdio: 'inherit' });

  console.log('[prepare] vsce package...');
  execFileSync('npx', ['vsce', 'package'], { cwd: dst, stdio: 'inherit' });

  const built = fs.readdirSync(dst).find(f => f.endsWith('.vsix'));
  if (!built) {
    console.error('[prepare] vsce did not produce a .vsix - see output above');
    process.exit(1);
  }

  const finalPath = path.join(EXT, built);
  fs.copyFileSync(path.join(dst, built), finalPath);
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`[prepare] ready: apps/vscode/${built}`);
}

function main() {
  vendorCore();
  buildOutsideWorkspace();
}

main();
