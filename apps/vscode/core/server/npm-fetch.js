// ER Studio - pull a package straight from the npm registry.
//
// Why this exists: the SDK reference used to have exactly two sources - the
// .d.ts inside the selected project's node_modules, and a snapshot baked into
// this repo at build time. That meant every time Even published a new SDK,
// ER Studio itself had to be rebuilt and re-released just to know about it.
//
// This module removes that coupling. The registry is the source of truth, and
// it is queried at runtime: metadata to learn the latest version, then the
// tarball to get the type definitions out of it. No npm subprocess, no
// install, no write into the user's project - just the two files we care
// about (package.json and whatever .d.ts it points at) held in a cache under
// ~/.er-studio.
//
// Everything here fails soft. Offline, proxied, rate-limited: the caller gets
// null and falls back to what it already had.

const zlib = require('zlib');

const REGISTRY = 'https://registry.npmjs.org';

/* ---------------- tar ----------------

   npm tarballs are gzipped tar. We want two small text files out of a stream
   that is a few hundred KB, so a full tar library would be a dependency for
   nothing: the ustar header is a fixed 512-byte record, the payload follows
   it padded to 512, and that is the entire format we need to walk. */

function untar(buf) {
  const files = new Map();
  let offset = 0;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);

    // Two consecutive zero blocks end the archive; one is enough to stop.
    if (header.every(b => b === 0)) break;

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const name = prefix ? `${prefix}/${rawName}` : rawName;

    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156] || 0x30);

    offset += 512;

    // '0' and '\0' are regular files. Directories, links and pax records are
    // skipped - their payload (if any) is still stepped over below.
    if (type === '0' || type === '\0') {
      files.set(name, buf.subarray(offset, offset + size));
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return files;
}

/* ---------------- registry ---------------- */

async function json(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`registry returned ${res.status}`);
  return res.json();
}

// The published metadata for <name>@<tag>. `latest` unless a caller pins one.
async function manifest(name, spec = 'latest', timeoutMs = 8000) {
  return json(`${REGISTRY}/${name.replace('/', '%2F')}/${encodeURIComponent(spec)}`, timeoutMs);
}

// Downloads the tarball for a resolved manifest and returns its files as a
// Map of path (without the leading "package/") -> Buffer.
async function tarballFiles(meta, timeoutMs = 20000) {
  const url = meta && meta.dist && meta.dist.tarball;
  if (!url) throw new Error('manifest has no tarball url');

  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`tarball returned ${res.status}`);

  const gz = Buffer.from(await res.arrayBuffer());
  const files = untar(zlib.gunzipSync(gz));

  const stripped = new Map();
  for (const [name, buf] of files) {
    stripped.set(name.replace(/^package\//, ''), buf);
  }
  return stripped;
}

module.exports = { manifest, tarballFiles, untar, REGISTRY };
