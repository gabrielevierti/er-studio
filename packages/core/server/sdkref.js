// ER Studio - SDK API reference
//
// Two layers, merged at serve time:
//
//   generated  parsed from the .d.ts of the SDK itself. Signatures, params,
//              kinds. Never edited, never stale - it IS the SDK.
//   overlay    data/sdk-overlay.json in this repo. English text (the SDK's
//              own JSDoc is Chinese), display constraints, grouping.
//
// Neither layer can be wrong about the other's job, which is the whole point
// of the split: a new SDK release changes the generated layer automatically
// and the overlay diff tells you what needs human attention.
//
// The generated layer is resolved in this order:
//
//   1. the .d.ts in the selected project's node_modules - what the user's
//      code actually imports, so it wins whenever it exists
//   2. the latest published SDK, pulled from the npm registry at runtime and
//      cached under ~/.er-studio/sdk-ref. This is what stops ER Studio from
//      needing a new release every time Even ships an SDK: the registry is
//      polled, not the build
//   3. the snapshot bundled in data/ - offline, first run, nothing installed
//
// Extraction runs once per SDK version and is cached to
// ~/.er-studio/sdk-ref/<version>.json, so the panel is never empty and never
// pays for the same parse twice.

const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');

const { parse } = require('./dts-parse');
const { PROJECT_PACKAGE, compareVersions } = require('./sdk');
const { manifest, tarballFiles } = require('./npm-fetch');

const OVERLAY_PATH = path.join(__dirname, '..', 'data', 'sdk-overlay.json');
const BUNDLED_PATH = path.join(__dirname, '..', 'data', 'sdk-reference.bundled.json');
const CACHE_DIR = path.join(os.homedir(), '.er-studio', 'sdk-ref');
const POINTER_PATH = path.join(CACHE_DIR, 'latest.json');

// How long a registry answer is trusted before we ask again. Short enough
// that a release published this morning shows up today, long enough that
// opening the panel twenty times costs one request.
const LATEST_TTL_MS = 6 * 60 * 60 * 1000;

const memo = new Map();   // version -> generated payload

/* ---------------- locating the installed SDK ---------------- */

function sdkDir(projectDir) {
  if (!projectDir) return null;
  const dir = path.join(projectDir, 'node_modules', ...PROJECT_PACKAGE.split('/'));
  return fs.existsSync(dir) ? dir : null;
}

// package.json "types" is authoritative; the fallbacks cover older layouts.
function dtsPath(dir) {
  const candidates = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.types || pkg.typings) candidates.push(path.join(dir, pkg.types || pkg.typings));
  } catch { /* fall through to conventional paths */ }
  candidates.push(path.join(dir, 'dist', 'index.d.ts'), path.join(dir, 'index.d.ts'));
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

function installedVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}

/* ---------------- generated layer ---------------- */

function cachePath(version) { return path.join(CACHE_DIR, `${version}.json`); }

function readCache(version) {
  try {
    const payload = JSON.parse(fs.readFileSync(cachePath(version), 'utf8'));
    return payload.schemaVersion === 1 ? payload : null;
  } catch { return null; }
}

function writeCache(version, payload) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(version), JSON.stringify(payload), 'utf8');
  } catch (err) {
    console.error('[er-studio] sdk reference cache write failed:', err.message);
  }
}

function buildGenerated(dir) {
  const version = installedVersion(dir) || 'unknown';
  if (memo.has(version)) return memo.get(version);

  const cached = readCache(version);
  if (cached) { memo.set(version, cached); return cached; }

  const dts = dtsPath(dir);
  if (!dts) return null;

  const started = Date.now();
  const parsed = parse(fs.readFileSync(dts, 'utf8'));
  const payload = {
    schemaVersion: 1,
    version,
    source: 'installed',
    generatedAt: Date.now(),
    parseMs: Date.now() - started,
    dtsFile: path.relative(dir, dts),
    symbols: parsed.symbols,
    unparsed: parsed.unparsed
  };

  if (parsed.unparsed.length) {
    console.error(`[er-studio] sdk reference: ${parsed.unparsed.length} exported symbol(s) not recognised by the parser:`, parsed.unparsed.join(', '));
  }

  memo.set(version, payload);
  writeCache(version, payload);
  return payload;
}

/* ---------------- latest published SDK (the auto-update path) ----------------

   The registry is asked for the current version, its tarball is unpacked in
   memory, and the .d.ts inside it is parsed exactly like an installed one.
   Nothing is written into any project and npm is never spawned.

   Every failure here is silent: the caller still has the installed SDK or
   the bundled snapshot, and an offline laptop must not turn the reference
   panel into an error. */

let latestInflight = null;

function readPointer() {
  try {
    const pointer = JSON.parse(fs.readFileSync(POINTER_PATH, 'utf8'));
    return pointer && pointer.version ? pointer : null;
  } catch { return null; }
}

function writePointer(pointer) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(POINTER_PATH, JSON.stringify(pointer), 'utf8');
  } catch (err) {
    console.error('[er-studio] sdk reference pointer write failed:', err.message);
  }
}

function dtsCachePath(version) { return path.join(CACHE_DIR, `${version}.d.ts`); }

// The .d.ts a package manifest points at, out of an already-unpacked tarball.
function pickDts(files, pkg) {
  const declared = pkg && (pkg.types || pkg.typings);
  const candidates = [
    declared && declared.replace(/^\.\//, ''),
    'dist/index.d.ts',
    'index.d.ts'
  ].filter(Boolean);

  for (const name of candidates) {
    if (files.has(name)) return { name, text: files.get(name).toString('utf8') };
  }

  // Bundler output moves around between releases; rather than give up when a
  // path changes, take the largest .d.ts in the tarball.
  let best = null;
  for (const [name, buf] of files) {
    if (!name.endsWith('.d.ts')) continue;
    if (!best || buf.length > best.buf.length) best = { name, buf };
  }
  return best ? { name: best.name, text: best.buf.toString('utf8') } : null;
}

// The cached payload for the last version we successfully pulled, if any.
// Synchronous, so it can serve a request while a refresh runs behind it.
function latestCached() {
  const pointer = readPointer();
  if (!pointer) return null;
  const payload = memo.get(pointer.version) || readCache(pointer.version);
  if (!payload) return null;
  memo.set(pointer.version, payload);
  return payload;
}

function pointerFresh() {
  const pointer = readPointer();
  return !!(pointer && Date.now() - (pointer.checkedAt || 0) < LATEST_TTL_MS);
}

async function fetchLatest() {
  const meta = await manifest(PROJECT_PACKAGE);
  const version = meta && meta.version;
  if (!version) throw new Error('registry manifest has no version');

  // Already parsed this exact release - record the check and stop. This is
  // the common case once a day: one small metadata request, no tarball.
  const cached = memo.get(version) || readCache(version);
  if (cached) {
    memo.set(version, cached);
    writePointer({ version, checkedAt: Date.now() });
    return cached;
  }

  const files = await tarballFiles(meta);
  let pkg = null;
  try { pkg = JSON.parse(files.get('package.json').toString('utf8')); } catch { /* optional */ }

  const dts = pickDts(files, pkg);
  if (!dts) throw new Error('no .d.ts in the published tarball');

  const started = Date.now();
  const parsed = parse(dts.text);
  const payload = {
    schemaVersion: 1,
    version,
    source: 'registry',
    generatedAt: Date.now(),
    parseMs: Date.now() - started,
    dtsFile: dts.name,
    symbols: parsed.symbols,
    unparsed: parsed.unparsed
  };

  memo.set(version, payload);
  writeCache(version, payload);
  // Kept as text too, so Monaco can be given real types for a project that
  // has not run npm install yet.
  try { fs.writeFileSync(dtsCachePath(version), dts.text, 'utf8'); } catch { /* optional */ }
  writePointer({ version, checkedAt: Date.now() });

  return payload;
}

// Single-flight. Several panels asking at once - and the doctor asking at the
// same time - must not become several tarball downloads.
function refreshLatest({ force = false } = {}) {
  if (latestInflight) return latestInflight;
  if (!force && pointerFresh()) return Promise.resolve(latestCached());

  latestInflight = fetchLatest()
    .catch(err => {
      console.error('[er-studio] sdk reference: could not reach the npm registry -', err.message);
      return latestCached();
    })
    .finally(() => { latestInflight = null; });

  return latestInflight;
}

function bundled() {
  try {
    const payload = JSON.parse(fs.readFileSync(BUNDLED_PATH, 'utf8'));
    payload.source = 'bundled';
    return payload;
  } catch { return null; }
}

/* ---------------- overlay layer ---------------- */

// Re-read on every request. The file is ~10 KB and being able to edit an
// entry and hit refresh is worth more than the cached read.
function readOverlay() {
  try { return JSON.parse(fs.readFileSync(OVERLAY_PATH, 'utf8')); }
  catch (err) {
    console.error('[er-studio] sdk overlay unreadable:', err.message);
    return { groups: [], assign: {}, symbols: {}, docLinks: { default: null, bySymbol: {} } };
  }
}

function groupIndex(overlay) {
  const index = new Map();
  for (const [groupId, names] of Object.entries(overlay.assign || {})) {
    for (const name of names) index.set(name, groupId);
  }
  return index;
}

/* ---------------- merge ---------------- */

// The generated layer wins on structure, the overlay wins on prose. Where the
// overlay is silent the original Chinese is passed through and tagged, so the
// UI can label it rather than pretending it is English.
// OFFICIAL DOCS resolution.
//
// Even's docs have no per-symbol API page - they say the .d.ts is the
// authoritative reference and document the API by topic. So a link is only
// ever "the page that covers this", and the UI is told how precise the match
// was so it can say so instead of implying a symbol page exists.
//
//   exact   the overlay names this symbol or member specifically
//   topic   fell through to the group's page
//   root    fell through to the docs home - honest last resort
function docLinkResolver(overlay) {
  const links = overlay.docLinks || {};
  const bySymbol = links.bySymbol || {};
  const byMember = links.byMember || {};
  const byGroup = links.byGroup || {};
  const labels = links.pageLabels || {};
  const fallback = links.default || null;

  const label = url => {
    if (!url) return null;
    const base = String(url).split('#')[0];
    return labels[base] || labels[url] || null;
  };

  return {
    forSymbol(name, group) {
      const exact = bySymbol[name];
      if (exact) return { url: exact, precision: 'exact', label: label(exact) };
      const topic = byGroup[group];
      if (topic) return { url: topic, precision: 'topic', label: label(topic) };
      if (fallback) return { url: fallback, precision: 'root', label: label(fallback) };
      return { url: null, precision: null, label: null };
    },
    // A member link is only worth rendering when it is more specific than the
    // one already shown on the symbol - otherwise it is the same button twice.
    forMember(ownerName, memberName) {
      const url = byMember[`${ownerName}.${memberName}`] || byMember[memberName] || null;
      return url ? { url, precision: 'exact', label: label(url) } : { url: null, precision: null, label: null };
    },
    mapped: name => !!bySymbol[name]
  };
}

function merge(generated, overlay) {
  const groups = groupIndex(overlay);
  const entries = overlay.symbols || {};
  const docs = docLinkResolver(overlay);

  const symbols = generated.symbols.map(sym => {
    const o = entries[sym.name] || {};
    const oMembers = o.members || {};
    const group = groups.get(sym.name) || 'other';
    const link = docs.forSymbol(sym.name, group);

    return {
      ...sym,
      group,
      summary: o.summary || sym.doc.summary || '',
      lang: o.summary ? 'en' : (sym.doc.summary ? 'zh' : null),
      original: o.summary ? sym.doc.summary || '' : '',
      notes: o.notes || [],
      example: o.example || (sym.doc.example && sym.doc.example.text) || '',
      docUrl: link.url,
      docPrecision: link.precision,
      docLabel: link.label,
      members: sym.members.map(m => {
        const om = oMembers[m.name] || {};
        const mLink = docs.forMember(sym.name, m.name);
        return {
          ...m,
          summary: om.summary || m.doc.summary || '',
          lang: om.summary ? 'en' : (m.doc.summary ? 'zh' : null),
          original: om.summary ? m.doc.summary || '' : '',
          notes: om.notes || [],
          docUrl: mLink.url && mLink.url !== link.url ? mLink.url : null,
          docLabel: mLink.url && mLink.url !== link.url ? mLink.label : null
        };
      })
    };
  });

  const known = new Set(generated.symbols.map(s => s.name));
  const orphans = Object.keys(entries).filter(n => !n.startsWith('$') && !known.has(n));
  const uncovered = symbols.filter(s => s.lang !== 'en').map(s => s.name);

  const usedGroups = new Set(symbols.map(s => s.group));
  const groupList = (overlay.groups || []).filter(g => usedGroups.has(g.id));
  if (usedGroups.has('other')) {
    groupList.push({ id: 'other', label: 'UNGROUPED', blurb: 'Not yet assigned a group in sdk-overlay.json.' });
  }

  return {
    version: generated.version,
    source: generated.source,
    dtsFile: generated.dtsFile || null,
    generatedAt: generated.generatedAt || null,
    overlayAuthoredAgainst: overlay.sdkVersionAuthoredAgainst || null,
    groups: groupList,
    symbols,
    drift: {
      orphanedOverlayEntries: orphans,
      symbolsWithoutEnglish: uncovered,
      // Symbols with no entry in docLinks.bySymbol. They still get a working
      // link via their group, but the mapping is worth topping up when Even
      // adds a page - this is what tells you which ones.
      symbolsWithoutDocLink: symbols.filter(s => s.docPrecision !== 'exact').map(s => s.name),
      unparsedExports: generated.unparsed || [],
      overlayStale: !!(overlay.sdkVersionAuthoredAgainst &&
                       generated.version &&
                       overlay.sdkVersionAuthoredAgainst !== generated.version)
    }
  };
}

/* ---------------- router ---------------- */

function createSdkRefRouter(workspaceRoot) {
  const router = express.Router();

  function projectDir(name) {
    if (!name) return null;
    const abs = path.resolve(workspaceRoot, name);
    const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
    if (abs !== workspaceRoot && !abs.startsWith(rootWithSep)) return null;
    return fs.existsSync(abs) ? abs : null;
  }

  // Installed SDK first, then whatever the registry last gave us, then the
  // bundled snapshot. The registry refresh runs in the background when we
  // already have something to serve, and is awaited only when we do not.
  async function resolveGenerated(project, { force = false } = {}) {
    const dir = sdkDir(projectDir(project));
    const installed = dir && buildGenerated(dir);

    if (force) {
      const fresh = await refreshLatest({ force: true });
      return installed || fresh || bundled();
    }

    const haveSomething = installed || latestCached() || bundled();
    if (haveSomething) {
      // Fire and forget: this request is served from what we have, and the
      // next one gets the new release.
      refreshLatest().catch(() => { /* already logged */ });
      return installed || latestCached() || bundled();
    }

    // Cold start with no project and no snapshot - worth the wait.
    return (await refreshLatest()) || null;
  }

  // GET /api/sdkref?project=<name>[&refresh=1]
  router.get('/', async (req, res) => {
    const generated = await resolveGenerated(req.query.project, { force: req.query.refresh === '1' });
    if (!generated) {
      return res.status(404).json({ error: 'No SDK reference available - install the SDK in a project, or connect to the network so the latest published SDK can be fetched' });
    }
    try {
      const payload = merge(generated, readOverlay());

      // What the registry says exists, alongside what this payload was built
      // from. The panel shows this as "0.0.15 published" rather than making
      // the user go and look.
      const pointer = readPointer();
      payload.latestPublished = pointer ? pointer.version : null;
      payload.latestCheckedAt = pointer ? pointer.checkedAt || null : null;
      payload.updateAvailable = !!(pointer && payload.version &&
                                   compareVersions(pointer.version, payload.version) > 0);

      res.json(payload);
    } catch (err) { res.status(500).json({ error: String(err.message || err) }); }
  });

  // GET /api/sdkref/dts?project=<name>
  // Raw definitions for Monaco's addExtraLib - hovers and completion in the
  // editor, from the same file the panel is generated from.
  router.get('/dts', async (req, res) => {
    const dir = sdkDir(projectDir(req.query.project));
    const file = dir && dtsPath(dir);
    if (file) {
      return res.type('text/plain').set('Cache-Control', 'no-store').send(fs.readFileSync(file, 'utf8'));
    }

    // No install in this project - hand the editor the latest published types
    // rather than nothing. Completion on `bridge.` works before the first
    // npm install, and keeps working after every SDK release with no rebuild
    // of ER Studio.
    await refreshLatest().catch(() => null);
    const pointer = readPointer();
    const cached = pointer && dtsCachePath(pointer.version);
    if (cached && fs.existsSync(cached)) {
      return res.type('text/plain').set('Cache-Control', 'no-store').send(fs.readFileSync(cached, 'utf8'));
    }

    res.status(404).json({ error: 'SDK type definitions not available - install the SDK in this project, or connect to the network' });
  });

  return router;
}

// Consumed by doctor.js so the diagnostics panel reports reference drift.
// Takes an already-resolved project directory (doctor has one on ctx, already
// containment-checked) rather than re-deriving it from a client-supplied name.
function referenceHealth(projectDir) {
  const dir = projectDir ? sdkDir(projectDir) : null;
  const generated = (dir && buildGenerated(dir)) || latestCached() || bundled();
  if (!generated) return { ok: false, reason: 'no reference available' };
  const merged = merge(generated, readOverlay());
  return {
    ok: merged.drift.unparsedExports.length === 0 && !merged.drift.overlayStale,
    version: merged.version,
    source: merged.source,
    symbolCount: merged.symbols.length,
    latestPublished: (readPointer() || {}).version || null,
    overlayAuthoredAgainst: merged.overlayAuthoredAgainst,
    ...merged.drift
  };
}

module.exports = {
  refreshLatest, latestCached, createSdkRefRouter, referenceHealth, buildGenerated, merge, readOverlay, sdkDir, dtsPath };