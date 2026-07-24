// ER Studio - workspace file system API
// All paths are relative to the workspace root. Absolute paths and traversal
// attempts are rejected before touching the disk.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');

const IGNORED = new Set(['node_modules', '.git', 'dist', '.DS_Store', 'out', '.apps-cache']);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // editor safety cap

function createFilesRouter(workspaceRoot) {
  const router = express.Router();

  // Resolve a client-supplied relative path safely inside the workspace.
  function resolveSafe(relPath) {
    if (typeof relPath !== 'string' || relPath.length === 0) return null;
    if (relPath.includes('\0')) return null;
    const abs = path.resolve(workspaceRoot, relPath);
    const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
    if (abs !== workspaceRoot && !abs.startsWith(rootWithSep)) return null;
    return abs;
  }

  async function buildTree(absDir, relDir, depth) {
    const entries = await fsp.readdir(absDir, { withFileTypes: true });
    const nodes = [];
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (e.isDirectory()) {
        const node = { name: e.name, path: rel, type: 'dir', children: [] };
        if (depth < 12) {
          try { node.children = await buildTree(path.join(absDir, e.name), rel, depth + 1); }
          catch { node.children = []; }
        }
        nodes.push(node);
      } else if (e.isFile()) {
        nodes.push({ name: e.name, path: rel, type: 'file' });
      }
    }
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }

  // Full workspace tree
  router.get('/tree', async (req, res) => {
    try {
      const tree = await buildTree(workspaceRoot, '', 0);
      res.json({ root: workspaceRoot, tree });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // Projects = top-level dirs containing package.json
  router.get('/projects', async (req, res) => {
    try {
      const entries = await fsp.readdir(workspaceRoot, { withFileTypes: true });
      const projects = [];
      for (const e of entries) {
        if (!e.isDirectory() || IGNORED.has(e.name)) continue;
        const pkg = path.join(workspaceRoot, e.name, 'package.json');
        const manifest = path.join(workspaceRoot, e.name, 'app.json');
        projects.push({
          name: e.name,
          hasPackage: fs.existsSync(pkg),
          hasManifest: fs.existsSync(manifest)
        });
      }
      res.json({ projects: projects.filter(p => p.hasPackage) });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // Read file
  router.get('/file', async (req, res) => {
    const abs = resolveSafe(req.query.path);
    if (!abs) return res.status(400).json({ error: 'Invalid path' });
    try {
      const st = await fsp.stat(abs);
      if (!st.isFile()) return res.status(400).json({ error: 'Not a file' });
      if (st.size > MAX_FILE_BYTES) return res.status(413).json({ error: 'File exceeds 2 MB editor limit' });
      const content = await fsp.readFile(abs, 'utf8');
      res.json({ path: req.query.path, content, mtimeMs: st.mtimeMs });
    } catch (err) {
      res.status(404).json({ error: String(err.message || err) });
    }
  });

  // Write file
  router.put('/file', async (req, res) => {
    const { path: relPath, content } = req.body || {};
    const abs = resolveSafe(relPath);
    if (!abs) return res.status(400).json({ error: 'Invalid path' });
    if (typeof content !== 'string') return res.status(400).json({ error: 'Missing content' });
    try {
      await fsp.writeFile(abs, content, 'utf8');
      const st = await fsp.stat(abs);
      res.json({ ok: true, mtimeMs: st.mtimeMs });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // Create file or directory
  router.post('/create', async (req, res) => {
    const { path: relPath, kind } = req.body || {};
    const abs = resolveSafe(relPath);
    if (!abs) return res.status(400).json({ error: 'Invalid path' });
    try {
      if (fs.existsSync(abs)) return res.status(409).json({ error: 'Already exists' });
      if (kind === 'dir') {
        await fsp.mkdir(abs, { recursive: true });
      } else {
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, '', 'utf8');
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // Rename / move
  router.post('/rename', async (req, res) => {
    const from = resolveSafe((req.body || {}).from);
    const to = resolveSafe((req.body || {}).to);
    if (!from || !to) return res.status(400).json({ error: 'Invalid path' });
    try {
      if (fs.existsSync(to)) return res.status(409).json({ error: 'Target already exists' });
      await fsp.rename(from, to);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // Delete
  router.delete('/file', async (req, res) => {
    const abs = resolveSafe(req.query.path);
    if (!abs) return res.status(400).json({ error: 'Invalid path' });
    if (abs === workspaceRoot) return res.status(400).json({ error: 'Refusing to delete workspace root' });
    try {
      await fsp.rm(abs, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  return router;
}

module.exports = { createFilesRouter };
