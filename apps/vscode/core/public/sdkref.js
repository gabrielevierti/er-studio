/* ER Studio - SDK reference panel
   Loaded after app.js as a classic script, so it shares that file's
   top-level lexical scope: $, $$, api, toast, state, editor, monacoRef.
   Nothing in app.js needs to change.

   Two jobs:
     1. feed the installed .d.ts to Monaco, so hovers and completion work
        on `bridge.` in the editor
     2. drive the REFERENCE dock panel
*/

'use strict';

(function sdkReference() {

  const refState = {
    data: null,
    loadedForProject: null,
    selected: null,
    query: '',
    collapsed: new Set(),
    extraLibFor: null,
    extraLibDisposable: null,
    followCursor: true
  };

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* ---------------- doc rendering ---------------- */

  // JSDoc bodies carry ``` fences and `inline` code. Render both, escape the rest.
  function renderDoc(text) {
    if (!text) return '';
    const parts = String(text).split(/```(?:\w+)?\n?([\s\S]*?)```/g);
    let html = '';
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        html += `<pre class="ref-code">${esc(parts[i].replace(/\s+$/, ''))}</pre>`;
      } else {
        html += parts[i]
          .split(/\n{2,}/)
          .filter(p => p.trim())
          .map(p => `<p>${esc(p).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>')}</p>`)
          .join('');
      }
    }
    return html;
  }

  /* ---------------- official docs links ----------------
     Even's docs have no per-symbol API page - they say the .d.ts is the
     authoritative reference and document the API by topic. The old button
     ignored that and sent every symbol to the marketing site, which is why it
     never opened anything useful. So: name the page the link actually opens,
     and when the match is only a group-level fallback, say so rather than
     dressing it up as a precise answer. */

  function docLinkHtml(sym) {
    if (!sym.docUrl) return '';
    const exact = sym.docPrecision === 'exact';
    const page = sym.docLabel || sym.docUrl;
    const label = sym.docLabel ? sym.docLabel : (exact ? 'Official docs' : 'Docs');
    const title = exact
      ? `Opens the official page documenting ${sym.name}: ${page}`
      : `No dedicated page for ${sym.name}. Opens the closest official page: ${page}`;
    return `<a class="icon-btn ref-doclink${exact ? '' : ' approx'}" href="${esc(sym.docUrl)}"
              target="_blank" rel="noopener" title="${esc(title)}">${esc(label.toUpperCase())} \u2197</a>`;
  }

  const memberDocHtml = m => (m.docUrl
    ? `<a class="ref-member-doc" href="${esc(m.docUrl)}" target="_blank" rel="noopener"
         title="${esc('Official docs: ' + (m.docLabel || m.docUrl))}">DOCS \u2197</a>`
    : '');

  const langBadge = lang =>
    lang === 'zh' ? '<span class="ref-lang zh" title="Original SDK doc comment (Chinese) - no overlay entry yet">ZH</span>'
    : lang === 'en' ? '<span class="ref-lang en" title="English text from data/sdk-overlay.json">EN</span>'
    : '';

  /* ---------------- loading ---------------- */

  async function load(force) {
    const project = state.project || '';
    if (!force && refState.loadedForProject === project && refState.data) return refState.data;

    setStatus('loading…');
    try {
      const data = await api('/api/sdkref?project=' + encodeURIComponent(project));
      refState.data = data;
      refState.loadedForProject = project;
      renderList();
      if (refState.selected) show(refState.selected);
      paintStatus();
      return data;
    } catch (e) {
      refState.data = null;
      setStatus('unavailable');
      $('#ref-list').innerHTML = `<div class="ref-empty">${esc(e.message)}</div>`;
      return null;
    }
  }

  function setStatus(text) { $('#ref-status').textContent = text; }

  function paintStatus() {
    const d = refState.data;
    if (!d) return;
    const drift = d.drift || {};
    const bits = [`${d.symbols.length} symbols`];
    if (d.source === 'bundled') bits.push('bundled snapshot');
    setStatus(bits.join(' · '));

    const warn = $('#ref-drift');
    const problems = [];
    if (drift.overlayStale) problems.push(`overlay authored against ${d.overlayAuthoredAgainst}, installed is ${d.version}`);
    if (drift.unparsedExports && drift.unparsedExports.length) problems.push(`${drift.unparsedExports.length} export(s) the parser did not recognise`);
    if (drift.orphanedOverlayEntries && drift.orphanedOverlayEntries.length) problems.push(`${drift.orphanedOverlayEntries.length} overlay entr(y/ies) for symbols that no longer exist`);
    if (drift.symbolsWithoutDocLink && drift.symbolsWithoutDocLink.length) problems.push(`${drift.symbolsWithoutDocLink.length} symbol(s) with no dedicated docs page`);
    warn.hidden = problems.length === 0;
    warn.textContent = problems.join(' — ');
  }

  /* ---------------- monaco types ---------------- */

  // Same file the panel is built from, handed to the language service so the
  // editor can answer the easy lookups without the panel being open at all.
  async function syncMonacoTypes() {
    if (!monacoRef || !state.project) return;
    if (refState.extraLibFor === state.project) return;

    try {
      const res = await fetch('/api/sdkref/dts?project=' + encodeURIComponent(state.project));
      if (!res.ok) return;
      const dts = await res.text();

      if (refState.extraLibDisposable) {
        try { refState.extraLibDisposable.dispose(); } catch { /* already gone */ }
      }

      const uri = 'file:///node_modules/@evenrealities/even_hub_sdk/index.d.ts';
      const defaults = monacoRef.languages.typescript.javascriptDefaults;
      refState.extraLibDisposable = defaults.addExtraLib(dts, uri);
      monacoRef.languages.typescript.typescriptDefaults.addExtraLib(dts, uri);
      refState.extraLibFor = state.project;
    } catch { /* editor still works without types */ }
  }

  /* ---------------- list ---------------- */

  function matches(sym, q) {
    if (!q) return true;
    const hay = (sym.name + ' ' + sym.signature + ' ' + sym.summary + ' ' +
                 sym.members.map(m => m.name).join(' ')).toLowerCase();
    return hay.includes(q);
  }

  function renderList() {
    const host = $('#ref-list');
    const d = refState.data;
    if (!d) return;

    const q = refState.query.trim().toLowerCase();
    const hits = d.symbols.filter(s => matches(s, q));

    if (!hits.length) {
      host.innerHTML = `<div class="ref-empty">no symbol matches “${esc(refState.query)}”</div>`;
      return;
    }

    const byGroup = new Map();
    for (const s of hits) {
      if (!byGroup.has(s.group)) byGroup.set(s.group, []);
      byGroup.get(s.group).push(s);
    }

    let html = '';
    for (const g of d.groups) {
      const items = byGroup.get(g.id);
      if (!items || !items.length) continue;
      // A search collapses nothing - you want to see every hit.
      const collapsed = !q && (refState.collapsed.has(g.id) || (g.collapsed && !refState.collapsed.has('!' + g.id)));
      html += `<div class="ref-group${collapsed ? ' collapsed' : ''}" data-group="${esc(g.id)}">
        <button class="ref-group-head" data-group="${esc(g.id)}">
          <span class="ref-caret">${collapsed ? '+' : '−'}</span>
          <span>${esc(g.label)}</span>
          <span class="ref-count">${items.length}</span>
        </button>`;
      if (!collapsed) {
        html += '<div class="ref-group-body">';
        for (const s of items) {
          html += `<button class="ref-item${refState.selected === s.name ? ' active' : ''}" data-sym="${esc(s.name)}">
            <span class="ref-kind k-${esc(s.kind)}">${esc(s.kind.slice(0, 5))}</span>
            <span class="ref-name">${esc(s.name)}</span>
          </button>`;
        }
        html += '</div>';
      }
      html += '</div>';
    }
    host.innerHTML = html;
  }

  /* ---------------- detail ---------------- */

  function memberHtml(m) {
    const notes = (m.notes || []).map(n => `<li>${esc(n)}</li>`).join('');
    const params = (m.doc.params || []).map(p =>
      `<div class="ref-param"><code>${esc(p.name)}</code>${p.type ? `<span class="ref-ptype">${esc(p.type)}</span>` : ''}<span>${esc(p.text)}</span></div>`
    ).join('');
    const ret = m.doc.returns && m.doc.returns.text
      ? `<div class="ref-returns"><span class="ref-sub">RETURNS</span>${renderDoc(m.doc.returns.text)}</div>` : '';

    return `<div class="ref-member" id="ref-m-${esc(m.name)}">
      <div class="ref-member-head">
        <code class="ref-sig">${esc(m.signature)}</code>
        ${m.static ? '<span class="ref-tag">static</span>' : ''}
        ${m.optional ? '<span class="ref-tag">optional</span>' : ''}
        ${langBadge(m.lang)}
        ${memberDocHtml(m)}
      </div>
      ${m.summary ? `<div class="ref-body">${renderDoc(m.summary)}</div>` : ''}
      ${notes ? `<ul class="ref-notes">${notes}</ul>` : ''}
      ${params ? `<div class="ref-params">${params}</div>` : ''}
      ${ret}
      ${m.original ? `<details class="ref-orig"><summary>original doc comment</summary>${renderDoc(m.original)}</details>` : ''}
    </div>`;
  }

  function show(name) {
    const d = refState.data;
    if (!d) return;
    const sym = d.symbols.find(s => s.name === name);
    const host = $('#ref-detail');
    if (!sym) { host.innerHTML = '<div class="ref-empty">select a symbol</div>'; return; }

    refState.selected = name;
    $$('#ref-list .ref-item').forEach(el => el.classList.toggle('active', el.dataset.sym === name));

    const notes = (sym.notes || []).map(n => `<li>${esc(n)}</li>`).join('');
    const methods = sym.members.filter(m => m.kind === 'method');
    const props = sym.members.filter(m => m.kind === 'property');
    const enums = sym.members.filter(m => m.kind === 'member');

    host.innerHTML = `
      <div class="ref-detail-head">
        <div class="ref-title">
          <span class="ref-kind k-${esc(sym.kind)}">${esc(sym.kind)}</span>
          <h3>${esc(sym.name)}</h3>
          ${langBadge(sym.lang)}
          ${sym.typeOnly ? '<span class="ref-tag">type-only export</span>' : ''}
        </div>
        <div class="ref-detail-actions">
          ${docLinkHtml(sym)}
          <button class="icon-btn" id="ref-copy-name" title="Copy symbol name">COPY</button>
        </div>
      </div>

      <code class="ref-sig ref-sig-top">${esc(sym.signature)}</code>

      ${sym.summary ? `<div class="ref-body">${renderDoc(sym.summary)}</div>`
                    : '<div class="ref-body ref-muted">No description in the SDK. Add one in data/sdk-overlay.json.</div>'}

      ${notes ? `<div class="ref-notes-block"><span class="ref-sub">NOTES</span><ul class="ref-notes">${notes}</ul></div>` : ''}
      ${sym.example ? `<div class="ref-example"><span class="ref-sub">EXAMPLE</span><pre class="ref-code">${esc(sym.example)}</pre></div>` : ''}
      ${sym.original ? `<details class="ref-orig"><summary>original doc comment</summary>${renderDoc(sym.original)}</details>` : ''}

      ${enums.length ? `<div class="ref-section"><span class="ref-sub">VALUES (${enums.length})</span>
        <div class="ref-enum-grid">${enums.map(m => `<div class="ref-enum"><code>${esc(m.signature.replace(/,$/, ''))}</code>${m.summary ? `<span>${esc(m.summary.split('\n')[0])}</span>` : ''}</div>`).join('')}</div></div>` : ''}

      ${props.length ? `<div class="ref-section"><span class="ref-sub">PROPERTIES (${props.length})</span>${props.map(memberHtml).join('')}</div>` : ''}
      ${methods.length ? `<div class="ref-section"><span class="ref-sub">METHODS (${methods.length})</span>${methods.map(memberHtml).join('')}</div>` : ''}
    `;

    const copy = $('#ref-copy-name');
    if (copy) {
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(sym.name).then(() => toast(`Copied "${sym.name}"`)).catch(() => {});
      });
    }
    host.scrollTop = 0;
  }

  /* ---------------- cursor context ---------------- */

  function isPanelVisible() {
    const p = $('#dock-sdkref');
    return p && p.classList.contains('active');
  }

  function jumpToWordAtCursor(explicit) {
    if (!editor || !refState.data) return false;
    const model = editor.getModel();
    const pos = editor.getPosition();
    if (!model || !pos) return false;
    const word = model.getWordAtPosition(pos);
    if (!word) return false;

    const exact = refState.data.symbols.find(s => s.name === word.word);
    if (exact) { show(exact.name); return true; }

    // Not a top-level symbol - it may be a member, e.g. the cursor is on
    // `rebuildPageContainer`. Find the owner and scroll to it.
    for (const sym of refState.data.symbols) {
      const m = sym.members.find(mm => mm.name === word.word);
      if (m) {
        show(sym.name);
        const el = document.getElementById('ref-m-' + m.name);
        if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 900); }
        return true;
      }
    }

    if (explicit) toast(`"${word.word}" is not in the SDK reference`);
    return false;
  }

  /* ---------------- wiring ---------------- */

  function wire() {
    // Bound to the event, not the tab element: panels.js rebuilds tabs on
    // every layout change, so an element-bound listener dies the first time
    // anything moves.
    window.addEventListener('panel:activate', ev => {
      if (ev.detail.panel !== 'sdkref') return;
      load(false);
      const search = $('#ref-search');
      if (search) setTimeout(() => search.focus(), 0);
    });

    // Docking or detaching re-parents the panel; reload so a window that was
    // opened before a project was selected doesn't sit there empty.
    window.addEventListener('panel:moved', ev => {
      if (ev.detail.panel === 'sdkref') load(false);
    });

    $('#ref-search').addEventListener('input', ev => {
      refState.query = ev.target.value;
      renderList();
    });

    $('#ref-search').addEventListener('keydown', ev => {
      if (ev.key === 'Enter') {
        const first = $('#ref-list .ref-item');
        if (first) show(first.dataset.sym);
      } else if (ev.key === 'Escape') {
        ev.target.value = '';
        refState.query = '';
        renderList();
      }
    });

    $('#ref-list').addEventListener('click', ev => {
      const item = ev.target.closest('.ref-item');
      if (item) { show(item.dataset.sym); return; }
      const head = ev.target.closest('.ref-group-head');
      if (head) {
        const id = head.dataset.group;
        // '!id' marks a group whose default-collapsed state was overridden.
        if (refState.collapsed.has(id)) { refState.collapsed.delete(id); refState.collapsed.add('!' + id); }
        else if (refState.collapsed.has('!' + id)) { refState.collapsed.delete('!' + id); refState.collapsed.add(id); }
        else refState.collapsed.add(id);
        renderList();
      }
    });

    $('#ref-follow').addEventListener('change', ev => { refState.followCursor = ev.target.checked; });
    $('#ref-reload').addEventListener('click', () => load(true).then(() => toast('SDK reference reloaded')));

    // Opening the panel is itself a request for the reference.
    const tab = $('.dock-tab[data-dock="sdkref"]');
    if (tab) {
      tab.addEventListener('click', () => {
        load(false);
        setTimeout(() => $('#ref-search').focus(), 0);
      });
    }

    // Project switches change which node_modules we read from.
    $('#project-select').addEventListener('change', () => {
      refState.loadedForProject = null;
      refState.extraLibFor = null;
      syncMonacoTypes();
      if (isPanelVisible() || ERPanels.isFloating('sdkref')) load(true);
    });
  }

  function wireEditor() {
    if (!editor || !monacoRef) return;

    editor.onDidChangeCursorPosition(() => {
      if (!refState.followCursor || !isPanelVisible()) return;
      clearTimeout(refState._cursorTimer);
      refState._cursorTimer = setTimeout(() => jumpToWordAtCursor(false), 180);
    });

    // Cmd/Ctrl+Shift+D - look up whatever is under the cursor.
    editor.addCommand(
      monacoRef.KeyMod.CtrlCmd | monacoRef.KeyMod.Shift | monacoRef.KeyCode.KeyD,
      async () => {
        const tab = $('.dock-tab[data-dock="sdkref"]');
        if (tab && !isPanelVisible()) tab.click();
        await load(false);
        jumpToWordAtCursor(true);
      }
    );
  }

  /* ---------------- host bridge ---------------- */

  // In embed mode there are no dock tabs to click and no Monaco editor to
  // follow, so the two things that made this panel useful - loading itself and
  // tracking the cursor - have to come from the host instead.
  const EMBED_PANEL = document.body.dataset.embedPanel || null;

  function lookupSymbol(name) {
    if (!name) return;
    const match = findSymbol(name);
    if (!match) return;
    show(match);
    const search = $('#ref-search');
    if (search && !refState.query) search.placeholder = name;
  }

  // Tolerant matching: the word under the cursor might be `sendText`, `SendText`
  // or a member expression like `glasses.sendText`.
  function findSymbol(word) {
    const symbols = (refState.data && refState.data.symbols) || [];
    const tail = String(word).split('.').pop();
    const exact = symbols.find(s => s.name === word) || symbols.find(s => s.name === tail);
    if (exact) return exact.name;
    const lower = String(tail).toLowerCase();
    const loose = symbols.find(s => s.name.toLowerCase() === lower);
    return loose ? loose.name : null;
  }

  if (EMBED_PANEL === 'sdkref') {
    // The panel is the whole page here: opening it IS the request for it.
    load(false);

    window.addEventListener('message', ev => {
      const msg = ev.data || {};
      if (msg.type === 'er-lookup' && refState.followCursor) lookupSymbol(msg.symbol);
      if (msg.type === 'er-reload') load(true);
    });

    // The host drives "follow cursor" now, so the checkbox still means
    // something - it just gates messages instead of editor events.
    const follow = $('#ref-follow');
    if (follow) follow.title = 'Follow the cursor in your VS Code editor';
  }

  /* ---------------- boot ---------------- */

  wire();

  // app.js resolves monaco asynchronously in its own boot(); poll briefly
  // rather than reaching into it.
  let waited = 0;
  const waitForEditor = setInterval(() => {
    if (editor && monacoRef) {
      clearInterval(waitForEditor);
      wireEditor();
      syncMonacoTypes();
    } else if ((waited += 120) > 20000) {
      clearInterval(waitForEditor);
    }
  }, 120);

  // Types are worth having even if the panel is never opened.
  setTimeout(syncMonacoTypes, 1500);

})();
