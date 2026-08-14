/* ER Studio - workspace / panel manager
   Loaded after app.js as a classic script, so it shares that file's top-level
   lexical scope ($, $$, toast, state, fitAddon, term).

   What it owns:
     - which zone (left / right / bottom) each panel lives in, and in what order
     - which panel is on top in each zone
     - tearing a panel off into its own OS window, including on another monitor
     - persisting all of the above across launches

   What it deliberately does not own: the panels themselves. A panel is just a
   .dock-panel element with its own toolbar. Moving one is a DOM move, so its
   listeners, its canvas bitmap and its scroll position all survive the trip -
   which is why xterm and the glasses mirror keep working after a tear-off.

   Tabs are still rendered as .dock-tab[data-dock="<id>"] and the visible panel
   still carries .active, so everything that already drove the dock by clicking
   a tab - openDoctor(), the REFERENCE shortcut in sdkref.js - keeps working.
*/

'use strict';

const ERPanels = (function panelManager() {

  const LAYOUT_KEY = 'er-workspace-layout';
  const LAYOUT_VERSION = 2;

  // `home` is where a panel returns when a layout is reset, when its floating
  // window closes, or when a stored layout turns out to be unreadable.
  const PANELS = [
    { id: 'workspace',       title: 'WORKSPACE',        home: 'left',   float: [420, 700] },
    { id: 'display',         title: 'DISPLAY',          home: 'right',  float: [520, 620] },
    { id: 'webview',         title: 'WEBVIEW',          home: 'right',  float: [760, 620] },
    { id: 'terminal',        title: 'TERMINAL',         home: 'bottom', float: [900, 480] },
    { id: 'process',         title: 'CONSOLE',          home: 'bottom', float: [900, 480], badge: 'badge-process' },
    { id: 'glasses-console', title: 'SIMULATOR CONSOLE', home: 'bottom', float: [900, 480], badge: 'badge-console', badgeClass: 'badge-err' },
    { id: 'metrics',         title: 'METRICS',          home: 'bottom', float: [980, 700] },
    { id: 'doctor',          title: 'DOCTOR',           home: 'bottom', float: [960, 720], badge: 'badge-doctor' },
    { id: 'sdkref',          title: 'REFERENCE',        home: 'bottom', float: [1040, 720] }
  ];

  const byId = new Map(PANELS.map(p => [p.id, p]));
  const ZONES = ['left', 'right', 'bottom'];

  // zone -> ordered panel ids. Floating panels appear in no zone.
  const layout = { left: [], right: [], bottom: [] };
  const active = { left: null, right: null, bottom: null };
  const floating = new Map();  // panelId -> { win, bounds }

  let dragging = null;         // panel id currently being dragged
  let restoring = false;       // suppress persistence while applying a layout

  /* ---------------- element lookup ---------------- */

  // The body may currently live in the main document or in a floating window.
  function bodyOf(id) {
    return $('#dock-' + id);
  }
  function zoneEl(zone) { return document.getElementById('zone-' + zone); }
  function tabsEl(zone) { return zoneEl(zone) && zoneEl(zone).querySelector('.zone-tabs'); }
  function stackEl(zone) { return zoneEl(zone) && zoneEl(zone).querySelector('.zone-stack'); }

  function zoneOf(id) {
    for (const zone of ZONES) if (layout[zone].includes(id)) return zone;
    return null;
  }

  /* ---------------- persistence ---------------- */

  function persist() {
    if (restoring) return;
    const floats = {};
    for (const [id, rec] of floating) floats[id] = readBounds(rec);
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({
        v: LAYOUT_VERSION,
        zones: { left: [...layout.left], right: [...layout.right], bottom: [...layout.bottom] },
        active: { ...active },
        floating: floats
      }));
    } catch { /* private mode, quota - the layout is not worth an error */ }
  }

  // A floating window that has been moved or resized reports its own geometry;
  // one that has already gone reports the last position we recorded.
  function readBounds(rec) {
    try {
      const w = rec.win;
      if (w && !w.closed) {
        return {
          x: Math.round(w.screenX), y: Math.round(w.screenY),
          w: Math.round(w.outerWidth), h: Math.round(w.outerHeight)
        };
      }
    } catch { /* cross-origin or torn down mid-read */ }
    return rec.bounds || null;
  }

  function readStored() {
    try {
      const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
      if (!raw || raw.v !== LAYOUT_VERSION) return null;
      return raw;
    } catch { return null; }
  }

  /* ---------------- rendering ---------------- */

  function render() {
    for (const zone of ZONES) {
      const tabs = tabsEl(zone);
      const stack = stackEl(zone);
      if (!tabs || !stack) continue;

      const ids = layout[zone];
      zoneEl(zone).hidden = ids.length === 0;
      document.body.classList.toggle('zone-' + zone + '-empty', ids.length === 0);

      // An empty zone should not leave a draggable seam behind it.
      const splitter = document.getElementById(
        zone === 'left' ? 'split-sidebar' : zone === 'right' ? 'split-devices' : 'split-dock');
      if (splitter) splitter.hidden = ids.length === 0;

      if (active[zone] && !ids.includes(active[zone])) active[zone] = null;
      if (!active[zone] && ids.length) active[zone] = ids[0];

      tabs.innerHTML = '';
      for (const id of ids) {
        tabs.appendChild(buildTab(id, zone));
        const body = bodyOf(id);
        if (body) {
          if (body.parentElement !== stack) stack.appendChild(body);
          body.classList.toggle('active', id === active[zone]);
        }
      }
      if (ids.length) tabs.appendChild(buildZoneActions(zone));
    }

    // A floating panel is always the visible one in its own window.
    for (const id of floating.keys()) {
      const body = bodyOf(id);
      if (body) body.classList.add('active');
    }

    paintFloatStatus();
    persist();
    window.dispatchEvent(new CustomEvent('panels:rendered'));
  }

  function buildTab(id, zone) {
    const panel = byId.get(id);
    const tab = document.createElement('button');
    tab.className = 'dock-tab' + (id === active[zone] ? ' active' : '');
    tab.dataset.dock = id;
    tab.draggable = true;
    tab.title = panel.title + ' - drag to another edge, or out of the window to detach';
    tab.append(document.createTextNode(panel.title));

    if (panel.badge) {
      const badge = document.createElement('span');
      badge.className = 'badge' + (panel.badgeClass ? ' ' + panel.badgeClass : '');
      badge.id = panel.badge;
      tab.appendChild(badge);
    }

    tab.addEventListener('click', () => activate(id));
    tab.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); tabMenu(ev, id); });
    tab.addEventListener('dragstart', ev => {
      dragging = id;
      document.body.classList.add('dragging-panel');
      try { ev.dataTransfer.setData('text/er-panel', id); } catch { /* older engines */ }
      ev.dataTransfer.effectAllowed = 'move';
    });
    tab.addEventListener('dragend', ev => {
      document.body.classList.remove('dragging-panel');
      clearDropHints();
      // Released outside the window and nothing accepted it: the intent was to
      // pull the panel out, so put it where the pointer was let go - which is
      // how a panel ends up on a second monitor.
      const outside = ev.screenX < window.screenX || ev.screenY < window.screenY ||
                      ev.screenX > window.screenX + window.outerWidth ||
                      ev.screenY > window.screenY + window.outerHeight;
      if (dragging && ev.dataTransfer.dropEffect === 'none' && outside) {
        detach(dragging, { x: Math.round(ev.screenX) - 40, y: Math.round(ev.screenY) - 20 });
      }
      dragging = null;
    });
    return tab;
  }

  function buildZoneActions(zone) {
    const wrap = document.createElement('span');
    wrap.className = 'zone-actions';

    const spacer = document.createElement('span');
    spacer.className = 'dock-spacer';
    wrap.appendChild(spacer);

    const pop = document.createElement('button');
    pop.className = 'icon-btn';
    pop.textContent = '\u29c9';
    pop.title = 'Open this panel in its own window';
    pop.addEventListener('click', () => { if (active[zone]) detach(active[zone]); });
    wrap.appendChild(pop);

    return wrap;
  }

  function paintFloatStatus() {
    const el = $('#status-float');
    if (!el) return;
    const n = floating.size;
    el.hidden = n === 0;
    el.textContent = n ? `${n} panel${n === 1 ? '' : 's'} detached` : '';
  }

  /* ---------------- moving panels ---------------- */

  function activate(id) {
    if (floating.has(id)) { focusFloat(id); return; }
    const zone = zoneOf(id);
    if (!zone || active[zone] === id) {
      if (zone) window.dispatchEvent(new CustomEvent('panel:activate', { detail: { panel: id, zone } }));
      return;
    }
    active[zone] = id;
    render();
    window.dispatchEvent(new CustomEvent('panel:activate', { detail: { panel: id, zone } }));
  }

  function move(id, zone, index) {
    if (!byId.has(id) || !ZONES.includes(zone)) return;
    if (floating.has(id)) { dock(id, zone, index); return; }

    const from = zoneOf(id);
    if (from) layout[from].splice(layout[from].indexOf(id), 1);

    const at = typeof index === 'number' ? Math.max(0, Math.min(index, layout[zone].length)) : layout[zone].length;
    layout[zone].splice(at, 0, id);
    active[zone] = id;

    render();
    window.dispatchEvent(new CustomEvent('panel:moved', { detail: { panel: id, zone, from } }));
    window.dispatchEvent(new CustomEvent('panel:activate', { detail: { panel: id, zone } }));
  }

  /* ---------------- drag and drop between zones ---------------- */

  function clearDropHints() {
    for (const zone of ZONES) {
      const el = zoneEl(zone);
      if (el) el.classList.remove('drop-target');
    }
    document.querySelectorAll('.dock-tab.drop-before').forEach(t => t.classList.remove('drop-before'));
  }

  // Insert position from the pointer: before the first tab whose midpoint the
  // pointer has not passed.
  function insertIndexAt(tabs, clientX) {
    const list = Array.from(tabs.querySelectorAll('.dock-tab'));
    for (let i = 0; i < list.length; i++) {
      const box = list[i].getBoundingClientRect();
      if (clientX < box.left + box.width / 2) return i;
    }
    return list.length;
  }

  function wireDropTargets() {
    for (const zone of ZONES) {
      const el = zoneEl(zone);
      if (!el) continue;

      el.addEventListener('dragover', ev => {
        if (!dragging) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        el.classList.add('drop-target');
      });
      el.addEventListener('dragleave', ev => {
        if (!el.contains(ev.relatedTarget)) el.classList.remove('drop-target');
      });
      el.addEventListener('drop', ev => {
        if (!dragging) return;
        ev.preventDefault();
        const tabs = tabsEl(zone);
        const overTabs = tabs && tabs.contains(ev.target);
        const index = overTabs ? insertIndexAt(tabs, ev.clientX) : undefined;
        const id = dragging;
        dragging = null;
        clearDropHints();
        move(id, zone, index);
      });
    }
  }

  /* ---------------- tearing off into a window ---------------- */

  function detach(id, at) {
    if (floating.has(id)) { focusFloat(id); return; }
    const panel = byId.get(id);
    const body = bodyOf(id);
    if (!panel || !body) return;

    const [w, h] = panel.float || [900, 600];
    const x = at && Number.isFinite(at.x) ? at.x : Math.round(window.screenX + 60);
    const y = at && Number.isFinite(at.y) ? at.y : Math.round(window.screenY + 60);

    // left/top are honoured across monitors, which is the whole point: a
    // negative or very large X is a perfectly valid second-screen coordinate.
    const features = `popup=yes,width=${w},height=${h},left=${x},top=${y}`;
    let win = null;
    try { win = window.open('panel.html?panel=' + encodeURIComponent(id), 'er-panel-' + id, features); }
    catch { win = null; }

    if (!win) {
      toast('The browser blocked the panel window - allow pop-ups for ER Studio', true);
      return;
    }

    const rec = { win, bounds: { x, y, w, h } };
    floating.set(id, rec);

    const from = zoneOf(id);
    if (from) {
      layout[from].splice(layout[from].indexOf(id), 1);
      if (active[from] === id) active[from] = null;
    }
    rec.home = from || panel.home;

    whenReady(win, () => adoptInto(win, id, rec));
    render();
  }

  // The popup is same-origin, so we can wait for its shell and then move the
  // live node across rather than rebuilding the panel from scratch.
  function whenReady(win, fn, tries) {
    tries = tries || 0;
    let root = null;
    try { root = win.document && win.document.getElementById('float-root'); } catch { /* still loading */ }
    if (root) return fn(root);
    if (tries > 200) return;                       // ~6 s, then give up quietly
    setTimeout(() => whenReady(win, fn, tries + 1), 30);
  }

  function adoptInto(win, id, rec) {
    const panel = byId.get(id);
    const body = bodyOf(id);
    const root = win.document.getElementById('float-root');
    if (!body || !root) return;

    win.document.title = 'ER Studio - ' + panel.title;
    const heading = win.document.getElementById('float-title');
    if (heading) heading.textContent = panel.title;

    root.appendChild(body);          // appendChild adopts across documents
    body.classList.add('active');

    // Every $ / $$ lookup in app.js searches these too, so code that has no
    // idea a panel moved keeps finding its elements.
    if (window.__erDocs) window.__erDocs.add(win.document);

    const dockBtn = win.document.getElementById('float-dock');
    if (dockBtn) dockBtn.addEventListener('click', () => win.close());

    // Closing the window must hand the node back before it is destroyed with
    // the document, or the panel is gone until a reload.
    win.addEventListener('pagehide', () => {
      if (rec.closing) return;              // dock() is already doing this
      rec.bounds = readBounds(rec);

      // Grab the node *before* this document leaves the lookup registry.
      // Once it does, $('#dock-<id>') can no longer see it and the panel
      // would dock back as an empty tab.
      let body = null;
      try { body = win.document.getElementById('dock-' + id); } catch { /* torn down */ }

      if (window.__erDocs) window.__erDocs.delete(win.document);
      floating.delete(id);
      dock(id, rec.home || panel.home, undefined, body);
    });

    win.addEventListener('resize', () => { rec.bounds = readBounds(rec); persist(); });

    window.dispatchEvent(new CustomEvent('panel:moved', { detail: { panel: id, zone: 'float', from: rec.home } }));
    window.dispatchEvent(new CustomEvent('panel:activate', { detail: { panel: id, zone: 'float' } }));
    render();
  }

  function dock(id, zone, index, bodyNode) {
    const rec = floating.get(id);
    if (rec) {
      rec.closing = true;                   // stop pagehide docking it twice
      floating.delete(id);
      try { if (window.__erDocs && rec.win) window.__erDocs.delete(rec.win.document); } catch { /* torn down */ }
      try { if (rec.win && !rec.win.closed) rec.win.close(); } catch { /* already gone */ }
    }

    const target = ZONES.includes(zone) ? zone : (byId.get(id) || {}).home || 'bottom';
    const body = bodyNode || bodyOf(id);
    const stack = stackEl(target);
    if (body && stack) stack.appendChild(body);   // adopts back into this document

    if (!layout[target].includes(id)) {
      const at = typeof index === 'number' ? index : layout[target].length;
      layout[target].splice(at, 0, id);
    }
    active[target] = id;
    render();
    window.dispatchEvent(new CustomEvent('panel:moved', { detail: { panel: id, zone: target, from: 'float' } }));
    window.dispatchEvent(new CustomEvent('panel:activate', { detail: { panel: id, zone: target } }));
  }

  function focusFloat(id) {
    const rec = floating.get(id);
    try { if (rec && rec.win && !rec.win.closed) rec.win.focus(); } catch { /* gone */ }
  }

  function dockAll() {
    for (const id of [...floating.keys()]) {
      const rec = floating.get(id);
      dock(id, (rec && rec.home) || (byId.get(id) || {}).home);
    }
  }

  /* ---------------- menus ---------------- */

  function menu(x, y, items) {
    const el = $('#ctx-menu');
    if (!el) return;
    el.innerHTML = '';
    for (const [label, fn, cls] of items) {
      if (label === '-') {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        el.appendChild(sep);
        continue;
      }
      const item = document.createElement('div');
      item.className = 'ctx-item' + (cls ? ' ' + cls : '');
      item.textContent = label;
      item.addEventListener('click', () => { el.hidden = true; fn(); });
      el.appendChild(item);
    }
    el.style.left = Math.min(x, window.innerWidth - 200) + 'px';
    el.style.top = Math.min(y, window.innerHeight - 200) + 'px';
    el.hidden = false;
  }

  function tabMenu(ev, id) {
    const here = zoneOf(id);
    const items = [];
    for (const zone of ZONES) {
      if (zone === here) continue;
      items.push([`Move to ${zone}`, () => move(id, zone)]);
    }
    items.push(['-']);
    items.push(['Open in new window', () => detach(id)]);
    menu(ev.clientX, ev.clientY, items);
  }

  function layoutMenu(ev) {
    const btn = ev.currentTarget.getBoundingClientRect();
    const items = [
      ['Dock all windows', dockAll],
      ['Reset layout', reset],
      ['-']
    ];
    // Anything that has been closed out of every zone can be brought back.
    for (const p of PANELS) {
      if (zoneOf(p.id) || floating.has(p.id)) continue;
      items.push([`Show ${p.title}`, () => move(p.id, p.home)]);
    }
    menu(btn.left, btn.bottom + 4, items);
  }

  /* ---------------- boot ---------------- */

  function applyDefaults() {
    for (const zone of ZONES) layout[zone].length = 0;
    for (const p of PANELS) layout[p.home].push(p.id);
    active.left = 'workspace';
    active.right = 'display';
    active.bottom = 'terminal';
  }

  function reset() {
    dockAll();
    restoring = true;
    applyDefaults();
    restoring = false;
    // Panel sizes live under the splitter's own key; a reset should clear
    // those too or the layout is only half back to default.
    try { localStorage.removeItem('er-layout'); } catch { /* ignore */ }
    for (const v of ['--sidebar-w', '--devices-w', '--dock-h']) {
      document.documentElement.style.removeProperty(v);
    }
    render();
    toast('Workspace layout reset');
  }

  function restore() {
    const stored = readStored();
    applyDefaults();
    if (!stored) return null;

    restoring = true;
    try {
      const seen = new Set();
      for (const zone of ZONES) layout[zone].length = 0;
      for (const zone of ZONES) {
        for (const id of (stored.zones && stored.zones[zone]) || []) {
          if (byId.has(id) && !seen.has(id)) { layout[zone].push(id); seen.add(id); }
        }
      }
      // A panel added by a newer version of ER Studio was not in the stored
      // layout; put it back at its home rather than leaving it unreachable.
      for (const p of PANELS) {
        if (!seen.has(p.id) && !(stored.floating && stored.floating[p.id])) layout[p.home].push(p.id);
      }
      for (const zone of ZONES) {
        active[zone] = layout[zone].includes(stored.active && stored.active[zone])
          ? stored.active[zone] : (layout[zone][0] || null);
      }
    } finally {
      restoring = false;
    }
    return stored.floating || null;
  }

  function init() {
    const floats = restore();
    wireDropTargets();
    render();

    const layoutBtn = $('#btn-layout');
    if (layoutBtn) layoutBtn.addEventListener('click', layoutMenu);

    // Reopening a torn-off window without a click is exactly what pop-up
    // blockers exist to stop. In Electron it is allowed and the panel comes
    // back where it was; in a plain browser it stays docked and says so.
    if (floats && Object.keys(floats).length) {
      let blocked = 0;
      for (const [id, bounds] of Object.entries(floats)) {
        if (!byId.has(id)) continue;
        const before = floating.size;
        detach(id, bounds);
        if (floating.size === before) blocked++;
      }
      if (blocked) toast(`${blocked} detached panel${blocked === 1 ? '' : 's'} could not reopen - allow pop-ups to restore them`, true);
    }

    // Never leave orphaned windows behind when the main window goes.
    window.addEventListener('beforeunload', () => {
      for (const rec of floating.values()) {
        try { if (rec.win && !rec.win.closed) rec.win.close(); } catch { /* ignore */ }
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { activate, move, detach, dock, dockAll, reset, zoneOf, isFloating: id => floating.has(id) };
})();
