// ER Studio - SDK API reference
//
// Two layers, merged at serve time:
//
//   generated  parsed from the .d.ts inside the selected project's
//              node_modules. Signatures, params, kinds. Never edited,
//              never stale - it IS the installed SDK.
//   overlay    data/sdk-overlay.json in this repo. English text (the SDK's
//              own JSDoc is Chinese), display constraints, grouping.
//
// Neither layer can be wrong about the other's job, which is the whole point
// of the split: a new SDK release changes the generated layer automatically
// and the overlay diff tells you what needs human attention.
//
// Extraction runs once per SDK version and is cached to
// ~/.er-studio/sdk-ref/<version>.json. With no project selected, no SDK
// installed, or no network, the bundled snapshot in data/ is served instead,
// so the panel is never empty.

const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');

const { parse } = require('./dts-parse');
const { PROJECT_PACKAGE } = require('./sdk');

const OVERLAY_PATH = path.join(__dirname, '..', 'data', 'sdk-overlay.json');
const BUNDLED_PATH = path.join(__dirname, '..', 'data', 'sdk-reference.bundled.json');
const CACHE_DIR = path.join(os.homedir(), '.er-studio', 'sdk-ref');

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

  function resolveGenerated(project) {
    const dir = sdkDir(projectDir(project));
    return (dir && buildGenerated(dir)) || bundled();
  }

  // GET /api/sdkref?project=<name>
  router.get('/', (req, res) => {
    const generated = resolveGenerated(req.query.project);
    if (!generated) {
      return res.status(404).json({ error: 'No SDK reference available - install the SDK in a project, or rebuild the bundled snapshot with tools/build-sdk-reference.js' });
    }
    try { res.json(merge(generated, readOverlay())); }
    catch (err) { res.status(500).json({ error: String(err.message || err) }); }
  });

  // GET /api/sdkref/dts?project=<name>
  // Raw definitions for Monaco's addExtraLib - hovers and completion in the
  // editor, from the same file the panel is generated from.
  router.get('/dts', (req, res) => {
    const dir = sdkDir(projectDir(req.query.project));
    const file = dir && dtsPath(dir);
    if (!file) return res.status(404).json({ error: 'SDK type definitions not found for this project' });
    res.type('text/plain').set('Cache-Control', 'no-store').send(fs.readFileSync(file, 'utf8'));
  });

  return router;
}

// Consumed by doctor.js so the diagnostics panel reports reference drift.
// Takes an already-resolved project directory (doctor has one on ctx, already
// containment-checked) rather than re-deriving it from a client-supplied name.
function referenceHealth(projectDir) {
  const dir = projectDir ? sdkDir(projectDir) : null;
  const generated = (dir && buildGenerated(dir)) || bundled();
  if (!generated) return { ok: false, reason: 'no reference available' };
  const merged = merge(generated, readOverlay());
  return {
    ok: merged.drift.unparsedExports.length === 0 && !merged.drift.overlayStale,
    version: merged.version,
    source: merged.source,
    symbolCount: merged.symbols.length,
    ...merged.drift
  };
}

module.exports = { createSdkRefRouter, referenceHealth, buildGenerated, merge, readOverlay, sdkDir, dtsPath };