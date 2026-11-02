// Jake's Data server entry. Serves the web app from JAKESDATA_WEB (default <repo>/web) and the JSON API
// under /api. Node 22, zero npm dependencies.
//
//   JAKESDATA_PORT  (4800)            JAKESDATA_BIND (0.0.0.0)
//   JAKESDATA_DATA  ($HOME/jakes-data-app-data)   JAKESDATA_WEB  (<repo>/web)
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApi, sendJson, isDbBusy } from './api.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(serverDir, '..');

const PORT = Number(process.env.JAKESDATA_PORT) || 4800;
const BIND = process.env.JAKESDATA_BIND || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.JAKESDATA_DATA || path.join(os.homedir(), 'jakes-data-app-data'));
const WEB_DIR = path.resolve(process.env.JAKESDATA_WEB || path.join(repoDir, 'web'));
// Symlink-resolved web dir: a stray symlink inside web/ must not let the static server
// read files outside it.
const REAL_WEB_DIR = realpathOr(WEB_DIR);
const INDEX_FILE = path.join(WEB_DIR, 'index.html');
const startedAt = new Date();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
// Icons/images may be cached for a day; everything else (html/js/css/webmanifest/json)
// is never cached so edits on the PC show up on the next load.
const LONG_CACHE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.woff', '.woff2']);

const config = loadConfig(path.join(serverDir, 'config.json'));
const store = openStore(DATA_DIR);
const handleApi = createApi({ notes: store.notes, config, webDir: WEB_DIR, repoDir, startedAt });

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`[jakes-data] unhandled error for ${req.method} ${req.url}:`, err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.destroy();
  });
});
server.keepAliveTimeout = 65_000;

server.on('error', (err) => {
  console.error(`[jakes-data] cannot listen on ${BIND}:${PORT}: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, BIND, () => {
  console.log(`[jakes-data] listening on http://${BIND}:${PORT}  web=${WEB_DIR}  data=${DATA_DIR}  node=${process.version}`);
});

function shutdown(signal) {
  console.log(`[jakes-data] ${signal} received, shutting down`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

function loadConfig(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed.services)) parsed.services = [];
    return parsed;
  } catch (err) {
    console.error(`[jakes-data] could not read ${file}: ${err.message}; showing no services`);
    return { services: [] };
  }
}

// One actionable line instead of a stack trace when the data dir is unwritable, read-only
// or a regular file (under Restart=always this would otherwise crash-loop in the journal).
function openStore(dataDir) {
  try {
    return openDb(dataDir);
  } catch (err) {
    const what = err && err.code === 'ERR_SQLITE_ERROR'
      ? `cannot open database ${path.join(dataDir, 'jakesdata.db')}`
      : `cannot open data dir ${dataDir}`;
    console.error(`[jakes-data] ${what}: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

function realpathOr(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

async function handle(req, res) {
  const t0 = performance.now();
  // 'close' fires for finished AND aborted responses ('finish' only for the former), so
  // requests the client gave up on still get their log line.
  res.on('close', () => {
    const ms = Math.round(performance.now() - t0);
    const status = res.headersSent ? res.statusCode : '-';
    console.log(`${req.method} ${req.url} ${status} ${ms}ms${res.writableFinished ? '' : ' aborted'}`);
  });

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: 'bad url' });
  }

  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (err) {
    if (isDbBusy(err)) {
      console.error(`[jakes-data] ${req.method} ${req.url}: database is busy (${err.message})`);
      if (!res.headersSent) return sendJson(res, 503, { error: 'database is busy, try again' }, { 'Retry-After': '1' });
      return res.destroy();
    }
    console.error(`[jakes-data] ${req.method} ${req.url} failed:`, err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.destroy();
  }
}

function hasDotDot(p) {
  return p.split(/[\\/]+/).includes('..');
}

// decodeURIComponent that never throws (malformed input is rejected later anyway).
function safeDecode(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return '';
  }
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
  }

  // Reject traversal on the raw request path before URL normalisation (the WHATWG parser
  // would otherwise quietly collapse "/.." and "/%2e%2e"), again on the decoded path, and
  // finally confirm the resolved file stays inside WEB_DIR.
  const rawPath = req.url.split('?')[0];
  if (hasDotDot(rawPath) || hasDotDot(safeDecode(rawPath))) return sendJson(res, 400, { error: 'bad path' });
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: 'bad path' });
  }
  if (pathname.includes('\0') || hasDotDot(pathname)) return sendJson(res, 400, { error: 'bad path' });

  const relative = pathname.replace(/^\/+/, '');
  let filePath = relative ? path.resolve(WEB_DIR, relative) : INDEX_FILE;
  if (filePath !== WEB_DIR && !filePath.startsWith(WEB_DIR + path.sep)) {
    return sendJson(res, 400, { error: 'bad path' });
  }

  let st = await statOrNull(filePath);
  // The lexical check above cannot see symlinks; the real path must also be inside web/.
  if (st && st.isFile() && !(await insideWebDir(filePath))) st = null;
  if (!st || !st.isFile()) {
    // A missing asset (last segment has an extension) is a real 404 so a typo in an
    // <img>/<link> href is not masked by a 200 index.html; extension-less routes get the
    // single-page app fallback.
    if (path.extname(relative)) return sendJson(res, 404, { error: 'not found' });
    filePath = INDEX_FILE;
    st = await statOrNull(filePath);
    if (!st || !st.isFile()) return sendJson(res, 404, { error: 'index.html is missing from the web directory' });
  }
  sendFile(req, res, filePath, st);
}

async function statOrNull(file) {
  try {
    return await fsp.stat(file);
  } catch {
    return null;
  }
}

async function insideWebDir(file) {
  try {
    const real = await fsp.realpath(file);
    return real.startsWith(REAL_WEB_DIR + path.sep);
  } catch {
    return false;
  }
}

function sendFile(req, res, filePath, st) {
  const ext = path.extname(filePath).toLowerCase();
  const mtimeMs = Math.floor(st.mtimeMs);
  const etag = `W/"${st.size.toString(16)}-${mtimeMs.toString(16)}"`;
  const validators = {
    'Cache-Control': LONG_CACHE_EXT.has(ext) ? 'public, max-age=86400' : 'no-store',
    'Last-Modified': st.mtime.toUTCString(),
    ETag: etag,
    'Access-Control-Allow-Origin': '*',
  };
  if (notModified(req, etag, mtimeMs)) {
    res.writeHead(304, validators);
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    'X-Content-Type-Options': 'nosniff',
    ...validators,
  });
  if (req.method === 'HEAD') return res.end();
  // pipeline() destroys the read stream when either side closes, so a download the phone
  // abandons mid-way does not leak the file descriptor (plain pipe() left it open).
  pipeline(fs.createReadStream(filePath), res, () => {});
}

// Conditional GET: If-None-Match wins when present (weak comparison), else If-Modified-Since
// at the second precision that Last-Modified carries.
function notModified(req, etag, mtimeMs) {
  const inm = req.headers['if-none-match'];
  if (inm) {
    const bare = etag.replace(/^W\//, '');
    return inm.split(',').some((tag) => {
      const t = tag.trim();
      return t === '*' || t.replace(/^W\//, '') === bare;
    });
  }
  const ims = Date.parse(req.headers['if-modified-since'] || '');
  return Number.isFinite(ims) && Math.floor(mtimeMs / 1000) <= Math.floor(ims / 1000);
}
