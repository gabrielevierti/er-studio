#!/usr/bin/env node
// Regenerate data/sdk-reference.bundled.json - the offline fallback served
// when no project is selected or the SDK is not installed.
//
//   node tools/build-sdk-reference.js                    # latest from npm
//   node tools/build-sdk-reference.js 0.0.13             # a specific version
//   node tools/build-sdk-reference.js --from <dir>       # a local install
//
// Run this when Even ships a new SDK, then check the drift report it prints:
// orphaned overlay entries are symbols that disappeared, and symbols without
// English are the new ones needing an overlay entry.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { parse } = require('../server/dts-parse');
const { merge, readOverlay, dtsPath } = require('../server/sdkref');

const PKG = '@evenrealities/even_hub_sdk';
const OUT = path.join(__dirname, '..', 'data', 'sdk-reference.bundled.json');

function fromNpm(version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'er-sdkref-'));
  const spec = version ? `${PKG}@${version}` : PKG;
  console.log(`fetching ${spec} ...`);
  execFileSync('npm', ['pack', spec, '--pack-destination', tmp], { stdio: ['ignore', 'pipe', 'inherit'] });
  const tgz = fs.readdirSync(tmp).find(f => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack produced no tarball');
  execFileSync('tar', ['xzf', path.join(tmp, tgz), '-C', tmp]);
  return path.join(tmp, 'package');
}

function main() {
  const args = process.argv.slice(2);
  const fromIdx = args.indexOf('--from');
  const dir = fromIdx !== -1 ? path.resolve(args[fromIdx + 1]) : fromNpm(args.find(a => !a.startsWith('--')));

  const dts = dtsPath(dir);
  if (!dts) throw new Error(`no .d.ts found under ${dir}`);
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;

  const parsed = parse(fs.readFileSync(dts, 'utf8'));
  const payload = {
    schemaVersion: 1,
    version,
    source: 'bundled',
    generatedAt: Date.now(),
    dtsFile: path.relative(dir, dts),
    symbols: parsed.symbols,
    unparsed: parsed.unparsed
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 0), 'utf8');

  const merged = merge(payload, readOverlay());
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);

  console.log(`\nwrote ${path.relative(process.cwd(), OUT)}  (${kb} KB)`);
  console.log(`  sdk version        ${version}`);
  console.log(`  symbols            ${payload.symbols.length}`);
  console.log(`  members            ${payload.symbols.reduce((a, s) => a + s.members.length, 0)}`);
  console.log('\ndrift report');
  console.log(`  unparsed exports   ${merged.drift.unparsedExports.length ? merged.drift.unparsedExports.join(', ') : 'none'}`);
  console.log(`  orphaned overlay   ${merged.drift.orphanedOverlayEntries.length ? merged.drift.orphanedOverlayEntries.join(', ') : 'none'}`);
  console.log(`  without English    ${merged.drift.symbolsWithoutEnglish.length}/${merged.symbols.length}`);
  if (merged.drift.overlayStale) {
    console.log(`\n  overlay says it was authored against ${merged.overlayAuthoredAgainst}, this is ${version}`);
    console.log('  update sdkVersionAuthoredAgainst in data/sdk-overlay.json once reviewed.');
  }
}

try { main(); }
catch (err) { console.error('failed:', err.message); process.exit(1); }
