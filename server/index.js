// Jake's Brain server entry. Serves the web app from JAKESDATA_WEB (default <repo>/web), the
// JSON API under /api (core routes + every module in server/apps/*.js), and uploads/thumbs
// under /media and /cache. Node 22, zero npm dependencies.
//
//   JAKESDATA_PORT   (4800)                          JAKESDATA_BIND    (0.0.0.0)
//   JAKESDATA_DATA   ($HOME/jakes-data-app-data)     JAKESDATA_WEB     (<repo>/web)
//   JAKESDATA_CONFIG (<repo>/server/config.json)     JAKESDATA_OLLAMA  (http://127.0.0.1:11434)
//   JAKESDATA_FFMPEG / JAKESDATA_FFPROBE             (else config.tools, else PATH)
//   JAKESDATA_CORS   extra allowed origins, comma-separated ('*' = any; default: none beyond
//                    this server's own addresses on its port and loopback dev servers)
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb, isDbBusy } from './db.js';
import { createRouter } from './router.js';
import { createTools } from './tools.js';
import { collectStatus } from './status.js';
import { sendJson, sendError, sendEmpty, sendFile, readJsonBody, HttpError, cors, configureCors } from './http.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(serverDir, '..');

const PORT = Number(process.env.JAKESDATA_PORT) || 4800;
const BIND = process.env.JAKESDATA_BIND || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.JAKESDATA_DATA || path.join(os.homedir(), 'jakes-data-app-data'));
const WEB_DIR = path.resolve(process.env.JAKESDATA_WEB || path.join(repoDir, 'web'));
const CONFIG_FILE = path.resolve(process.env.JAKESDATA_CONFIG || path.join(serverDir, 'config.json'));
const OLLAMA_URL = (process.env.JAKESDATA_OLLAMA || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const INDEX_FILE = path.join(WEB_DIR, 'index.html');
const GIT_CACHE_MS = 10_000;
const APP_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SETTING_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
// Names that land on Object.prototype instead of being a plain key (invisible garbage rows).
const SETTING_KEY_BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
const SETTING_STRING_MAX = 4096;
const REGISTER_TIMEOUT_MS = 20_000; // an async register() that never settles must not block startup
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const CORS_EXTRA = String(process.env.JAKESDATA_CORS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const startedAt = new Date();

// Icons/images may be cached for a day; everything else (html/js/css/json/svg/webmanifest)
// is never cached so edits on the PC show up on the next load.
const LONG_CACHE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2']);

const log = makeLog('jakes-data');
const cfg = loadConfig(CONFIG_FILE);
const store = openStore(DATA_DIR);
configureCors(originAllowed);
for (const dir of [MEDIA_DIR, CACHE_DIR]) fs.mkdirSync(dir, { recursive: true });
// Symlink-resolved roots: a stray symlink inside web/ or the data dir must not let the
// static servers read files outside them.
const REAL_WEB_DIR = realpathOr(WEB_DIR);
const REAL_MEDIA_DIR = realpathOr(MEDIA_DIR);
const REAL_CACHE_DIR = realpathOr(CACHE_DIR);
const tools = createTools(cfg, { log });
const router = createRouter({ log });

registerCore(router);
const modules = await loadModules(path.join(serverDir, 'apps'));

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log.error(`unhandled error for ${req.method} ${req.url}:`, err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.destroy();
  });
});
server.keepAliveTimeout = 65_000;
server.requestTimeout = 15 * 60_000; // a 300 MB upload over Tailscale can take a while
server.headersTimeout = 70_000;

server.on('error', (err) => {
  log.error(`cannot listen on ${BIND}:${PORT}: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, BIND, () => {
  log.info(`listening on http://${BIND}:${PORT}  web=${WEB_DIR}  data=${DATA_DIR}  node=${process.version}`);
  log.info(`modules: ${modules.length ? modules.join(', ') : '(none)'}  ffmpeg=${tools.ffmpeg || 'none'}  ffprobe=${tools.ffprobe || 'none'}`);
});

function shutdown(signal) {
  log.info(`${signal} received, shutting down`);
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
// A module's fire-and-forget mistake (a background probe without .catch, a throw inside a
// timer) is logged like a 500 instead of ending the process: one bug in one app must not
// take every app offline (and under Restart=always, crash-loop in the journal).
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection (the server stays up):', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err, origin) => {
  log.error(`uncaught exception (${origin}; the server stays up):`, err && err.stack ? err.stack : err);
});

// ---------------------------------------------------------------- setup

function makeLog(name) {
  const prefix = `[${name}]`;
  const info = (...args) => console.log(prefix, ...args);
  info.info = info;
  info.warn = (...args) => console.warn(prefix, ...args);
  info.error = (...args) => console.error(prefix, ...args);
  return info;
}

function loadConfig(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config must be a JSON object');
    if (!Array.isArray(parsed.services)) parsed.services = [];
    if (!Array.isArray(parsed.fileRoots)) parsed.fileRoots = [];
    if (!Array.isArray(parsed.videoChannels)) parsed.videoChannels = [];
    if (!parsed.tools || typeof parsed.tools !== 'object') parsed.tools = {};
    if (!parsed.gpt || typeof parsed.gpt !== 'object') parsed.gpt = {};
    if (!parsed.weather || typeof parsed.weather !== 'object') parsed.weather = {};
    parsed.ollamaUrl = OLLAMA_URL;
    return parsed;
  } catch (err) {
    log.error(`could not read ${file}: ${err.message}; running with an empty config`);
    return { services: [], fileRoots: [], videoChannels: [], tools: {}, gpt: {}, weather: {}, ollamaUrl: OLLAMA_URL };
  }
}

// One actionable line instead of a stack trace when the data dir is unwritable, read-only
// or a regular file (under Restart=always this would otherwise crash-loop in the journal).
function openStore(dataDir) {
  try {
    const opened = openDb(dataDir);
    if (opened.appliedCore && opened.appliedCore.length) log.info(`core: applied migrations ${opened.appliedCore.join(', ')}`);
    return opened;
  } catch (err) {
    const what = err && err.code === 'ERR_SQLITE_ERROR'
      ? `cannot open database ${path.join(dataDir, 'jakesdata.db')}`
      : `cannot open data dir ${dataDir}`;
    log.error(`${what}: ${err && err.message ? err.message : err}`);
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

// CORS allow-list: an origin is this server under one of its own names/addresses on its port
// (the page loaded via the Tailscale IP calling the LAN IP), a loopback dev server at any port
// (only code already running on the viewer's own device can produce that origin), or a
// JAKESDATA_CORS entry. Everything else gets no CORS headers at all.
let ownHostsCache = { at: 0, hosts: new Set() };
function ownHosts() {
  if (Date.now() - ownHostsCache.at < 60_000) return ownHostsCache.hosts;
  const hosts = new Set();
  try { hosts.add(String(os.hostname()).toLowerCase()); } catch { /* ignore */ }
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) if (ni && ni.address) hosts.add(String(ni.address).toLowerCase().replace(/%.*$/, ''));
    }
  } catch { /* ignore */ }
  ownHostsCache = { at: Date.now(), hosts };
  return hosts;
}

function originAllowed(origin) {
  if (CORS_EXTRA.includes('*') || CORS_EXTRA.includes(origin)) return true;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return port === PORT && ownHosts().has(host);
}

// Ids of the web apps that exist: web/apps/<id>/index.js. The launcher uses this to say
// "Not built yet" without probing (a 404 would be a console error on every tap).
function listWebApps() {
  const dir = path.join(WEB_DIR, 'apps');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => {
    if (!APP_ID_RE.test(name)) return false;
    try {
      return fs.statSync(path.join(dir, name, 'index.js')).isFile();
    } catch {
      return false;
    }
  }).sort();
}

// `~` and `~/x` -> the server user's home.
function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

function makeCtx(id) {
  const dirFor = (base) => (appId = id) => {
    if (!APP_ID_RE.test(String(appId))) throw new TypeError(`bad app id: ${appId}`);
    const dir = path.join(base, appId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  return {
    db: store.db,
    cfg,
    dataDir: DATA_DIR,
    mediaDir: dirFor(MEDIA_DIR),   // DATA/media/<id>, created
    cacheDir: CACHE_DIR,           // DATA/cache (the module makes its own subfolder, or uses cacheDirFor)
    cacheDirFor: dirFor(CACHE_DIR), // DATA/cache/<id>, created
    tools,
    log: makeLog(`jakes-data:${id}`),
    homeDir: os.homedir(),
    expandHome,
    settings: store.settings,      // { all(), get(key, fallback), patch({k: v|null}) }
    routes: () => router.routes(), // every live route, 'METHOD /pattern' (the connector's catalog)
    webDir: WEB_DIR,
    startedAt,
  };
}

// readdirSync(server/apps) -> import each default export { id, migrations, register(r, ctx) },
// apply its migrations (alphabetical by module id, after core), then register its routes.
// A module that throws (or returns a rejecting promise, or never settles) at any of those
// steps is logged and skipped; the server stays up. Routes are registered through a staging
// router and only go live once register() has finished, so a throw halfway leaves nothing.
async function loadModules(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.js') && !n.startsWith('.') && !n.startsWith('_')).sort();
  } catch {
    return [];
  }
  const loaded = [];
  const seen = new Set();
  for (const name of names) {
    const file = path.join(dir, name);
    const stem = name.slice(0, -3);
    try {
      const mod = (await import(pathToFileURL(file).href)).default;
      if (!mod || typeof mod !== 'object') throw new Error('default export must be an object { id, migrations, register }');
      if (typeof mod.id !== 'string' || !APP_ID_RE.test(mod.id)) throw new Error(`bad module id ${JSON.stringify(mod.id)}`);
      if (typeof mod.register !== 'function') throw new Error('register(r, ctx) is missing');
      if (mod.id !== stem) log.warn(`module ${name}: id "${mod.id}" does not match the file name`);
      if (seen.has(mod.id)) throw new Error(`duplicate module id "${mod.id}"`);
      seen.add(mod.id);
      loaded.push({ mod, name });
    } catch (err) {
      log.error(`module ${name} failed to load and was skipped:`, err && err.stack ? err.stack : err);
    }
  }
  loaded.sort((a, b) => (a.mod.id < b.mod.id ? -1 : a.mod.id > b.mod.id ? 1 : 0));
  const registered = [];
  for (const { mod, name } of loaded) {
    try {
      const applied = store.applyMigrations(mod.id, mod.migrations);
      if (applied.length) log.info(`${mod.id}: applied migrations ${applied.join(', ')}`);
    } catch (err) {
      log.error(`module ${name}: migrations failed, module skipped:`, err && err.stack ? err.stack : err);
      continue;
    }
    const staged = router.stage();
    try {
      await withTimeout(Promise.resolve(mod.register(staged, makeCtx(mod.id))), REGISTER_TIMEOUT_MS, `register() did not finish within ${REGISTER_TIMEOUT_MS / 1000} s`);
      staged.commit();
      registered.push(mod.id);
    } catch (err) {
      staged.discard();
      log.error(`module ${name}: register() threw, module skipped:`, err && err.stack ? err.stack : err);
    }
  }
  return registered;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- core routes

function registerCore(r) {
  // Last known-good sha. A transient git failure (slow disk, the 1 s timeout) must NOT flip
  // `build` to "nogit-…" and back: every open web app reloads itself on each change.
  let gitCache = { value: null, at: 0 };
  let gitInflight = null;

  function gitSha() {
    const now = Date.now();
    if (now - gitCache.at < GIT_CACHE_MS) return Promise.resolve(gitCache.value);
    if (gitInflight) return gitInflight;
    gitInflight = new Promise((resolve) => {
      let child;
      const done = (sha) => {
        gitCache = { value: sha || gitCache.value, at: Date.now() };
        gitInflight = null;
        resolve(gitCache.value);
      };
      try {
        child = execFile(
          'git',
          ['rev-parse', '--short', 'HEAD'],
          { cwd: repoDir, timeout: 1000, encoding: 'utf8', windowsHide: true },
          (err, stdout) => done(err ? null : String(stdout).trim() || null),
        );
        child.on('error', () => done(null));
      } catch {
        done(null);
      }
    });
    return gitInflight;
  }
  gitSha(); // warm the cache so the first /api/version does not wait on a git spawn

  // Max mtime (ms, as a string) of every file under web/, so the build changes when
  // web files are edited on the PC without a commit.
  function maxWebMtime() {
    let max = 0;
    try {
      for (const entry of fs.readdirSync(WEB_DIR, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue;
        const dir = entry.parentPath !== undefined ? entry.parentPath : entry.path;
        try {
          const st = fs.statSync(path.join(dir, entry.name));
          if (st.mtimeMs > max) max = st.mtimeMs;
        } catch { /* file vanished mid-walk */ }
      }
    } catch { /* web dir missing */ }
    return String(Math.floor(max));
  }

  r.get('/api/health', () => ({ ok: true, name: 'jakes-data', host: os.hostname(), time: new Date().toISOString() }));

  r.get('/api/version', async () => ({
    build: `${(await gitSha()) || 'nogit'}-${maxWebMtime()}`,
    started: startedAt.toISOString(),
    node: process.version,
  }));

  r.get('/api/status', () => collectStatus(cfg));

  // apps = server modules that registered; web = web/apps/<id>/index.js that exist.
  r.get('/api/apps', () => ({ apps: modules.slice(), web: listWebApps() }));

  r.get('/api/settings', () => ({ settings: store.settings.all() }));

  r.patch('/api/settings', async (req) => {
    const body = await readJsonBody(req);
    const keys = Object.keys(body).filter((key) => Object.hasOwn(body, key));
    if (!keys.length) throw new HttpError(400, 'nothing to update: send { key: value }');
    for (const key of keys) {
      if (!SETTING_KEY_RE.test(key) || SETTING_KEY_BLOCKED.has(key)) throw new HttpError(400, `bad setting key: ${JSON.stringify(key)}`);
      const value = body[key];
      if (value === null) continue;
      if (typeof value === 'string') {
        if (value.length > SETTING_STRING_MAX) throw new HttpError(400, `${key}: value is too long (max ${SETTING_STRING_MAX} characters)`);
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new HttpError(400, `${key}: value must be a finite number`);
      } else if (typeof value !== 'boolean') {
        throw new HttpError(400, `${key}: value must be a string, number, boolean or null`);
      }
    }
    store.settings.patch(body);
    return { settings: store.settings.all() };
  });
}

// ---------------------------------------------------------------- request handling

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
    // CORS headers only for an allowed Origin (see originAllowed); the app is same-origin.
    const corsAllowed = cors(req, res);
    if (req.method === 'OPTIONS') return sendEmpty(res, 204, corsAllowed ? { 'Access-Control-Max-Age': '600' } : {});
    const p = url.pathname;
    if (p === '/api' || p.startsWith('/api/')) {
      const handled = await router.handle(req, res, url);
      if (!handled) sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (p === '/media' || p.startsWith('/media/')) return await serveData(req, res, url, MEDIA_DIR, REAL_MEDIA_DIR, 'media');
    if (p === '/cache' || p.startsWith('/cache/')) return await serveData(req, res, url, CACHE_DIR, REAL_CACHE_DIR, 'cache');
    await serveStatic(req, res, url);
  } catch (err) {
    if (isDbBusy(err)) {
      log.error(`${req.method} ${req.url}: database is busy (${err.message})`);
      if (!res.headersSent) return sendJson(res, 503, { error: 'database is busy, try again' }, { 'Retry-After': '1' });
      return res.destroy();
    }
    log.error(`${req.method} ${req.url} failed:`, err);
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

// Reject traversal on the raw request path before URL normalisation (the WHATWG parser
// would otherwise quietly collapse "/.." and "/%2e%2e"), again on the decoded path, and
// return the decoded pathname; null when rejected (a 400 was sent).
function cleanPathname(req, res, url) {
  const rawPath = req.url.split('?')[0];
  if (hasDotDot(rawPath) || hasDotDot(safeDecode(rawPath))) {
    sendJson(res, 400, { error: 'bad path' });
    return null;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(res, 400, { error: 'bad path' });
    return null;
  }
  if (pathname.includes('\0') || hasDotDot(pathname)) {
    sendJson(res, 400, { error: 'bad path' });
    return null;
  }
  return pathname;
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
  }
  const pathname = cleanPathname(req, res, url);
  if (pathname === null) return;

  const relative = pathname.replace(/^\/+/, '');
  // Dotfiles (.DS_Store, .env, editor swap files, a .git if JAKESDATA_WEB ever points at a
  // repo root) are never served, same rule as /media and /cache.
  if (relative.split('/').some((seg) => seg.startsWith('.'))) return sendJson(res, 404, { error: 'not found' });
  let filePath = relative ? path.resolve(WEB_DIR, relative) : INDEX_FILE;
  if (filePath !== WEB_DIR && !filePath.startsWith(WEB_DIR + path.sep)) {
    return sendJson(res, 400, { error: 'bad path' });
  }

  let st = await statOrNull(filePath);
  // The lexical check above cannot see symlinks; the real path must also be inside web/.
  if (st && st.isFile() && !(await insideDir(filePath, REAL_WEB_DIR))) st = null;
  if (!st || !st.isFile()) {
    // A missing asset (last segment has an extension) is a real 404 so a typo in an
    // <img>/<link> href is not masked by a 200 index.html; extension-less routes get the
    // single-page app fallback.
    if (path.extname(relative)) return sendJson(res, 404, { error: 'not found' });
    filePath = INDEX_FILE;
    st = await statOrNull(filePath);
    if (!st || !st.isFile()) return sendJson(res, 404, { error: 'index.html is missing from the web directory' });
  }
  const ext = path.extname(filePath).toLowerCase();
  await sendFile(req, res, filePath, {
    stat: st,
    cacheControl: LONG_CACHE_EXT.has(ext) ? 'public, max-age=86400' : 'no-store',
  });
}

// GET /media/<app>/<file…> and /cache/<app>/<file…> from DATA/media and DATA/cache, with
// Range support. Traversal rejected (lexical + realpath), dotfiles hidden, directories 404.
async function serveData(req, res, url, baseDir, realBaseDir, kind) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
  }
  const pathname = cleanPathname(req, res, url);
  if (pathname === null) return;
  const segments = pathname.split('/').slice(2).filter(Boolean); // drop '' and the '/media' prefix
  if (segments.length < 2) return sendJson(res, 404, { error: 'not found' });
  if (segments.some((s) => s.startsWith('.'))) return sendJson(res, 404, { error: 'not found' });
  if (!APP_ID_RE.test(segments[0])) return sendJson(res, 404, { error: 'not found' });

  const filePath = path.resolve(baseDir, ...segments);
  if (!filePath.startsWith(baseDir + path.sep)) return sendJson(res, 400, { error: 'bad path' });
  let real;
  try {
    real = await fsp.realpath(filePath);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
  if (!real.startsWith(realBaseDir + path.sep)) return sendJson(res, 404, { error: 'not found' });
  const st = await statOrNull(real);
  if (!st || !st.isFile()) return sendJson(res, 404, { error: 'not found' });
  // Uploads are named by id and thumbnails are regenerable, so an hour of caching is safe.
  await sendFile(req, res, real, { stat: st, cacheControl: kind === 'media' ? 'public, max-age=86400' : 'public, max-age=3600' });
}

async function statOrNull(file) {
  try {
    return await fsp.stat(file);
  } catch {
    return null;
  }
}

async function insideDir(file, realDir) {
  try {
    const real = await fsp.realpath(file);
    return real.startsWith(realDir + path.sep);
  } catch {
    return false;
  }
}
