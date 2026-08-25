// ER Studio - simulator automation proxy
// The evenhub-simulator exposes its control plane on 127.0.0.1:9898 when
// launched with --automation-port. Proxying through our own server avoids
// CORS issues and keeps the UI on a single origin.

const express = require('express');

function createSimRouter(automationPort) {
  const router = express.Router();
  const BASE = `http://127.0.0.1:${automationPort}`;

  async function proxyJson(res, url, init) {
    try {
      const r = await fetch(url, init);
      const text = await r.text();
      res.status(r.status);
      try { res.json(JSON.parse(text)); }
      catch { res.type('text/plain').send(text); }
    } catch {
      res.status(502).json({ error: 'Simulator control plane not reachable' });
    }
  }

  router.get('/ping', (req, res) => proxyJson(res, `${BASE}/api/ping`));

  // Frame coalescing.
  //
  // Several clients can be mirroring at once - the simulator panel, the metrics
  // panel, a browser tab - and each used to trigger its own round trip to the
  // simulator. The simulator renders one framebuffer regardless, so callers
  // arriving while a fetch is in flight are served that same fetch, and a frame
  // that is only a few milliseconds old is reused rather than re-requested.
  //
  // The window is deliberately short: long enough to collapse a burst of
  // simultaneous callers, far shorter than a frame at 60 Hz, so nobody sees a
  // stale mirror.
  const FRAME_MAX_AGE_MS = 8;
  const frames = new Map(); // kind -> { at, buf, inflight }

  async function grabFrame(kind, endpoint) {
    const entry = frames.get(kind) || {};

    if (entry.inflight) return entry.inflight;
    if (entry.buf && Date.now() - entry.at < FRAME_MAX_AGE_MS) return entry.buf;

    const inflight = (async () => {
      const r = await fetch(`${BASE}${endpoint}`);
      if (!r.ok) throw Object.assign(new Error(`Simulator returned ${r.status}`), { status: r.status });
      const buf = Buffer.from(await r.arrayBuffer());
      frames.set(kind, { at: Date.now(), buf, inflight: null });
      return buf;
    })();

    frames.set(kind, { ...entry, inflight });

    try {
      return await inflight;
    } catch (err) {
      frames.set(kind, { ...entry, inflight: null });
      throw err;
    }
  }

  function sendFrame(kind, endpoint) {
    return async (req, res) => {
      try {
        const buf = await grabFrame(kind, endpoint);
        res.type('image/png').set('Cache-Control', 'no-store').send(buf);
      } catch (err) {
        if (err.status) return res.status(502).json({ error: `Simulator returned ${err.status}` });
        res.status(502).json({ error: 'Simulator control plane not reachable' });
      }
    };
  }

  router.get('/screenshot', sendFrame('glasses', '/api/screenshot/glasses'));
  router.get('/webview-screenshot', sendFrame('webview', '/api/screenshot/webview'));

  router.get('/console', (req, res) => {
    const since = parseInt(req.query.since_id, 10);
    const qs = Number.isFinite(since) ? `?since_id=${since}` : '';
    proxyJson(res, `${BASE}/api/console${qs}`);
  });

  router.delete('/console', (req, res) => {
    proxyJson(res, `${BASE}/api/console`, { method: 'DELETE' });
  });

  // Input actions.
  //
  // The known set is listed for documentation, not enforcement: the simulator
  // gains actions faster than this file is edited - long press arrived that
  // way - and hard-coding the list meant a new one could not be used until ER
  // Studio shipped again. So the shape is validated here (a lowercase
  // snake_case token, which is all the control plane accepts) and the
  // simulator itself remains the authority on which of them exist. An
  // unknown action comes back as its 4xx, which the pad surfaces as a toast.
  const KNOWN_ACTIONS = [
    'up', 'down', 'click', 'double_click',
    'long_press', 'long_press_release'
  ];
  const ACTION_RE = /^[a-z][a-z0-9_]{0,31}$/;

  router.get('/actions', (req, res) => res.json({ actions: KNOWN_ACTIONS }));

  router.post('/input', (req, res) => {
    const action = (req.body || {}).action;
    if (typeof action !== 'string' || !ACTION_RE.test(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }
    proxyJson(res, `${BASE}/api/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
  });

  return router;
}

module.exports = { createSimRouter };
