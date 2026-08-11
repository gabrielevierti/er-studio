// ER Studio - .d.ts symbol extractor
//
// @evenrealities/even_hub_sdk ships one bundler-generated dist/index.d.ts with
// no import graph: flat top-level `declare` statements, 4-space members, and a
// single trailing `export { ... }` block. That regularity is why this is a
// line parser and not a TypeScript compiler dependency - pulling in `typescript`
// would add ~60 MB to an Electron bundle to read one generated file.
//
// If Even ever ships a multi-file or hand-written .d.ts this will degrade
// (it reports what it recognises and skips the rest, it does not throw), and
// swapping in ts.createSourceFile becomes the right call. parse() returning
// noticeably fewer symbols than the export block lists is the signal - the
// `unparsed` array in the result carries exactly that.

// `declare` is optional: the bundler emits `declare class` but bare
// `type X = ...` and `interface Y { ... }`.
const TOP_DECL = /^(?:declare\s+)?(class|function|enum|namespace|const|type|interface)\s+([A-Za-z_$][\w$]*)/;
// `(` method, `:` property or interface field, `=` enum member.
const MEMBER = /^\s{4}(?:static\s+|readonly\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*(\??)\s*([(:=])/;
const MEMBER_KIND = { '(': 'method', ':': 'property', '=': 'member' };

// Strip the comment furniture from a raw JSDoc block, keeping @tags and fenced
// code intact so the UI can render them.
function cleanDoc(lines) {
  return lines
    .map(l => l.replace(/^\s*\/\*\*+/, '').replace(/\*+\/\s*$/, '').replace(/^\s*\*ss?/, '').replace(/^\s*\*/, ''))
    .map(l => l.replace(/^ /, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

// @param / @returns are worth structuring; everything else stays prose.
function splitTags(doc) {
  const out = { summary: '', params: [], returns: null, example: null, tags: [] };
  if (!doc) return out;

  const fences = [];
  let body = doc.replace(/```[\s\S]*?```/g, m => `\u0000${fences.push(m) - 1}\u0000`);

  const lines = body.split('\n');
  const summary = [];
  let current = null;

  for (const line of lines) {
    const tag = line.match(/^\s*@(\w+)\s*(.*)$/);
    if (tag) {
      const [, name, rest] = tag;
      if (name === 'param') {
        const p = rest.match(/^\{([^}]*)\}\s*(\S+)\s*-?\s*(.*)$/) || rest.match(/^(\S*)()\s*-?\s*(.*)$/);
        current = { kind: 'param', name: p ? (p[2] || p[1]) : rest, type: p && p[2] ? p[1] : null, text: p ? p[3] : '' };
        out.params.push(current);
      } else if (name === 'returns' || name === 'return') {
        current = { kind: 'returns', text: rest };
        out.returns = current;
      } else if (name === 'example') {
        current = { kind: 'example', text: rest };
        out.example = current;
      } else {
        current = { kind: name, text: rest };
        out.tags.push(current);
      }
      continue;
    }
    if (current) current.text += (current.text ? '\n' : '') + line;
    else summary.push(line);
  }

  const restore = s => (s || '').replace(/\u0000(\d+)\u0000/g, (_, i) => fences[Number(i)]);
  out.summary = restore(summary.join('\n')).trim();
  for (const p of out.params) p.text = restore(p.text).trim();
  if (out.returns) out.returns.text = restore(out.returns.text).trim();
  if (out.example) out.example.text = restore(out.example.text).trim();
  for (const t of out.tags) t.text = restore(t.text).trim();
  return out;
}

// A declaration's signature is everything up to the body, collapsed to one line.
function signatureOf(text) {
  const head = text.split(/\s\{/)[0].replace(/;\s*$/, '');
  return head.replace(/\s+/g, ' ').trim();
}

function parse(source) {
  const lines = source.split(/\r?\n/);
  const symbols = [];
  const exportsSeen = { all: [], typeOnly: new Set() };

  let doc = null;          // JSDoc block waiting to attach to the next declaration
  let docBuf = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ---- JSDoc block ----
    if (/^\s*\/\*\*/.test(line)) {
      docBuf = [line];
      while (!/\*\//.test(lines[i]) && i < lines.length - 1) { i++; docBuf.push(lines[i]); }
      doc = cleanDoc(docBuf);
      i++;
      continue;
    }

    // ---- trailing export block ----
    if (/^export\s*\{/.test(line)) {
      let block = line;
      while (!/\}/.test(block) && i < lines.length - 1) { i++; block += lines[i]; }
      const inner = block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'));
      for (let entry of inner.split(',')) {
        entry = entry.trim();
        if (!entry) continue;
        const typeOnly = /^type\s+/.test(entry);
        const name = entry.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        exportsSeen.all.push(name);
        if (typeOnly) exportsSeen.typeOnly.add(name);
      }
      i++;
      continue;
    }

    // ---- top-level declaration ----
    const m = line.match(TOP_DECL);
    if (m) {
      const [, kind, name] = m;
      const start = i;
      let text = line;
      let members = [];

      if (/\{/.test(line) && kind !== 'const' && kind !== 'function') {
        // Block declaration: walk to the matching brace, collecting members.
        let depth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
        let memberDoc = null;
        let memberDocBuf = null;

        while (depth > 0 && i < lines.length - 1) {
          i++;
          const ln = lines[i];
          text += '\n' + ln;

          if (/^\s*\/\*\*/.test(ln)) {
            memberDocBuf = [ln];
            while (!/\*\//.test(lines[i]) && i < lines.length - 1) { i++; memberDocBuf.push(lines[i]); text += '\n' + lines[i]; }
            memberDoc = cleanDoc(memberDocBuf);
            depth += (memberDocBuf.join('\n').match(/\{/g) || []).length - (memberDocBuf.join('\n').match(/\}/g) || []).length;
            continue;
          }

          const mm = ln.match(MEMBER);
          if (mm && depth === 1) {
            members.push({
              name: mm[1],
              kind: MEMBER_KIND[mm[3]],
              static: /^\s{4}static\s/.test(ln),
              optional: mm[2] === '?',
              signature: signatureOf(ln.trim()),
              doc: splitTags(memberDoc)
            });
            memberDoc = null;
          } else if (mm === null && ln.trim() && !/^\s*[}\])]/.test(ln)) {
            memberDoc = memberDoc && /^\s{4}/.test(ln) ? memberDoc : memberDoc;
          }

          depth += (ln.match(/\{/g) || []).length - (ln.match(/\}/g) || []).length;
        }
      } else if (kind === 'type' && !/;\s*$/.test(line)) {
        // Multi-line type alias: run to the terminating semicolon.
        let depth = (line.match(/[{[(]/g) || []).length - (line.match(/[}\])]/g) || []).length;
        while (i < lines.length - 1 && (depth > 0 || !/;\s*$/.test(lines[i]))) {
          i++;
          text += '\n' + lines[i];
          depth += (lines[i].match(/[{[(]/g) || []).length - (lines[i].match(/[}\])]/g) || []).length;
        }
      }

      symbols.push({
        name,
        kind,
        signature: signatureOf(text),
        line: start + 1,
        doc: splitTags(doc),
        members
      });
      doc = null;
      i++;
      continue;
    }

    if (line.trim()) doc = null;   // a non-declaration line orphans a pending block
    i++;
  }

  // Merge duplicate names (enum + companion namespace is the SDK's usual shape).
  const byName = new Map();
  for (const s of symbols) {
    const prior = byName.get(s.name);
    if (!prior) { byName.set(s.name, s); continue; }
    prior.members = prior.members.concat(s.members);
    if (!prior.doc.summary && s.doc.summary) prior.doc = s.doc;
    if (prior.kind === 'namespace' && s.kind !== 'namespace') prior.kind = s.kind;
  }

  const merged = [...byName.values()];
  const known = new Set(merged.map(s => s.name));

  for (const s of merged) {
    s.exported = exportsSeen.all.length === 0 || exportsSeen.all.includes(s.name);
    s.typeOnly = exportsSeen.typeOnly.has(s.name);
  }

  return {
    symbols: merged.sort((a, b) => a.name.localeCompare(b.name)),
    exported: exportsSeen.all,
    unparsed: exportsSeen.all.filter(n => !known.has(n))
  };
}

module.exports = { parse, splitTags, cleanDoc };
