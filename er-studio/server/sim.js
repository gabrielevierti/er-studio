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

  router.get('/screenshot', async (req, res) => {
    try {
      const r = await fetch(`${BASE}/api/screenshot/glasses`);
      if (!r.ok) return res.status(502).json({ error: `Simulator returned ${r.status}` });
      const buf = Buffer.from(await r.arrayBuffer());
      res.type('image/png').set('Cache-Control', 'no-store').send(buf);
    } catch {
      res.status(502).json({ error: 'Simulator control plane not reachable' });
    }
  });

  router.get('/webview-screenshot', async (req, res) => {
    try {
      const r = await fetch(`${BASE}/api/screenshot/webview`);
      if (!r.ok) return res.status(502).json({ error: `Simulator returned ${r.status}` });
      const buf = Buffer.from(await r.arrayBuffer());
      res.type('image/png').set('Cache-Control', 'no-store').send(buf);
    } catch {
      res.status(502).json({ error: 'Simulator control plane not reachable' });
    }
  });

  router.get('/console', (req, res) => {
    const since = parseInt(req.query.since_id, 10);
    const qs = Number.isFinite(since) ? `?since_id=${since}` : '';
    proxyJson(res, `${BASE}/api/console${qs}`);
  });

  router.delete('/console', (req, res) => {
    proxyJson(res, `${BASE}/api/console`, { method: 'DELETE' });
  });

  router.post('/input', (req, res) => {
    const action = (req.body || {}).action;
    const allowed = new Set(['up', 'down', 'click', 'double_click']);
    if (!allowed.has(action)) return res.status(400).json({ error: 'Invalid action' });
    proxyJson(res, `${BASE}/api/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
  });

  return router;
}

module.exports = { createSimRouter };
