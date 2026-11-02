// HTTP helpers shared by the core and every app module: JSON responses, CORS, body readers,
// and a Range-capable file sender (video seeking, HEAD, 206, 416). Zero npm dependencies.
//
// Error convention: helpers THROW `HttpError(status, message)` for bad input; the router
// turns a thrown HttpError into `{ "error": message }` with that status, so a handler can
// simply `const body = await readJsonBody(req)` and trust what comes back.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';

export const JSON_TYPE = 'application/json; charset=utf-8';
export const MAX_JSON_BYTES = 64 * 1024;
// A client that sends nothing for this long mid-body is gone (a 300 MB upload over Tailscale
// still has 15 minutes in total, see server.requestTimeout); small JSON bodies get 30 s.
export const BODY_IDLE_MS = 30_000;
export const UPLOAD_IDLE_MS = 120_000;

// Sent only to an allowed Origin (see cors()); Access-Control-Allow-Origin is reflected, never '*'.
export const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Filename, Range, If-None-Match, If-Modified-Since, If-Range',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Content-Disposition, ETag',
});

export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
});

export function mimeFor(file) {
  return MIME[path.extname(String(file)).toLowerCase()] || 'application/octet-stream';
}

export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers;
  }
}

// The allow-list is configured by index.js (this server under its own addresses, loopback dev
// servers, JAKESDATA_CORS). The server is unauthenticated on the LAN/tailnet, so an arbitrary
// web page must not be able to read or change Jake's data with a cross-origin fetch; the app
// itself is same-origin (the shell loads it from this server) and never needs CORS.
let originAllowed = () => false;
export function configureCors(fn) {
  originAllowed = typeof fn === 'function' ? fn : () => false;
}

// Sets the CORS headers on `res` when the request's Origin is allowed; returns whether it was.
// Called once per request by index.js, so every response (JSON, files, streams) carries them.
export function cors(req, res) {
  if (!res) { // legacy cors(res)
    res = req;
    req = res && res.req;
  }
  if (!res || typeof res.setHeader !== 'function') return false;
  res.setHeader('Vary', 'Origin');
  const origin = req && req.headers ? req.headers.origin : undefined;
  if (typeof origin !== 'string' || !origin || !originAllowed(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
  return true;
}

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body === undefined ? null : body);
  res.writeHead(status, {
    'Content-Type': JSON_TYPE,
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendError(res, status, message, extraHeaders = {}) {
  sendJson(res, status, { error: String(message) }, extraHeaders);
}

export function sendEmpty(res, status, extraHeaders = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...extraHeaders });
  res.end();
}

// 408 for a body that stops arriving. `Connection: close` makes Node drop the socket after
// the response instead of waiting to drain the rest of the body from a client that is gone.
function stalledBody() {
  return new HttpError(408, 'request body timed out', { Connection: 'close' });
}

// Reads the whole request body into a Buffer, capped at `limit` bytes (413 beyond it) and
// `idleMs` of silence between chunks (408).
export function readRawBody(req, { limit = MAX_JSON_BYTES, idleMs = BODY_IDLE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, `body too large (max ${humanLimit(limit)})`);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      return reject(tooLarge());
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    let idle = 0;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      if (err) {
        chunks.length = 0;
        req.resume(); // keep draining so the socket can be reused
        reject(err);
      } else {
        resolve(value);
      }
    };
    const arm = () => {
      if (!(idleMs > 0)) return;
      clearTimeout(idle);
      idle = setTimeout(() => finish(stalledBody()), idleMs);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      arm();
      size += chunk.length;
      if (size > limit) return finish(tooLarge());
      chunks.push(chunk);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks)));
    req.on('error', () => finish(new HttpError(400, 'could not read body')));
    req.on('aborted', () => finish(new HttpError(400, 'request aborted')));
    arm();
  });
}

// Reads a JSON object body (an object, not an array/scalar), capped at `limit` (64 KB).
export async function readJsonBody(req, { limit = MAX_JSON_BYTES, idleMs = BODY_IDLE_MS } = {}) {
  const raw = (await readRawBody(req, { limit, idleMs })).toString('utf8');
  if (!raw.trim()) throw new HttpError(400, 'invalid JSON body');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'JSON body must be an object');
  }
  return value;
}

// Streams the request body straight into `absPath` (for uploads: no 300 MB buffers).
// Resolves { bytes }. Over the limit: the partial file is deleted and 413 is thrown; a body
// that goes silent for `idleMs` is dropped the same way with a 408.
export function saveRawBody(req, absPath, { limit = 300 * 1024 * 1024, idleMs = UPLOAD_IDLE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, `body too large (max ${humanLimit(limit)})`);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      return reject(tooLarge());
    }
    let size = 0;
    let settled = false;
    let idle = 0;
    const out = fs.createWriteStream(absPath, { flags: 'w' });
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      req.unpipe(out);
      req.resume();
      out.destroy();
      fs.rm(absPath, { force: true }, () => reject(err));
    };
    const arm = () => {
      if (!(idleMs > 0)) return;
      clearTimeout(idle);
      idle = setTimeout(() => fail(stalledBody()), idleMs);
    };
    req.on('data', (chunk) => {
      arm();
      size += chunk.length;
      if (size > limit) fail(tooLarge());
    });
    req.on('error', () => fail(new HttpError(400, 'could not read body')));
    req.on('aborted', () => fail(new HttpError(400, 'request aborted')));
    out.on('error', (err) => fail(new HttpError(500, `could not write file: ${err.message}`)));
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      resolve({ bytes: size });
    });
    arm();
    req.pipe(out);
  });
}

// The upload helper in web/kit.js sends `X-Filename: encodeURIComponent(file.name)`.
// Returns the decoded basename (no directories, no control chars) or null.
export function requestFilename(req) {
  const raw = req.headers['x-filename'];
  if (!raw || typeof raw !== 'string') return null;
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch { /* sent undecoded */ }
  name = path.basename(name.replace(/[\\/]+/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name && name !== '.' && name !== '..' ? name.slice(0, 255) : null;
}

function humanLimit(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

// ---------------------------------------------------------------- files + ranges

// Parses a Range header against a file size (RFC 9110 §14). Returns:
//   null             no usable single range (missing / malformed / multi-range / last < first)
//                    -> ignore the header, send the whole file
//   'unsatisfiable'  the range lies entirely outside the file -> 416
//   { start, end }   inclusive byte offsets
export function parseRange(header, size) {
  if (!header || typeof header !== 'string') return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null; // multiple ranges or another unit: ignore, serve 200
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  // "bytes=5-3" is syntactically invalid (last-byte-pos < first-byte-pos): the whole header is ignored.
  if (a !== '' && b !== '' && Number(b) < Number(a)) return null;
  if (size <= 0) return 'unsatisfiable';
  let start;
  let end;
  if (a === '') {
    // suffix: last N bytes
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    // A first-byte-pos too large to represent is beyond any file we can serve.
    if (!Number.isSafeInteger(start)) return 'unsatisfiable';
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

// Sends a file with validators, conditional GET, HEAD and HTTP Range support.
//   cacheControl  'no-store' (default) | 'public, max-age=86400' | ...
//   download      true | 'name.ext' -> Content-Disposition: attachment
//   contentType   override the extension-derived type
//   stat          an fs.Stats already in hand (skips the stat call)
// The caller is responsible for containment checks (realpath inside the allowed root).
export async function sendFile(req, res, absPath, { cacheControl = 'no-store', download = false, contentType, stat } = {}) {
  let st = stat;
  if (!st) {
    try {
      st = await fsp.stat(absPath);
    } catch {
      return sendError(res, 404, 'not found');
    }
  }
  if (!st.isFile()) return sendError(res, 404, 'not found');

  const size = st.size;
  const mtimeMs = Math.floor(st.mtimeMs);
  // Strong ETag on purpose: If-Range only honours strong validators, and <video> seeking
  // sends If-Range with whatever ETag we handed out.
  const etag = `"${size.toString(16)}-${mtimeMs.toString(16)}"`;
  const headers = {
    'Content-Type': contentType || mimeFor(absPath),
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'Last-Modified': st.mtime.toUTCString(),
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  };
  if (download) {
    const name = typeof download === 'string' ? download : path.basename(absPath);
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
    headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }

  // If-None-Match / If-Modified-Since are evaluated before Range (RFC 9110 §13.2.2): a
  // client that already has the current file gets 304 whatever else it asked for.
  const rangeHeader = req.headers.range;
  if (notModified(req, etag, mtimeMs)) {
    res.writeHead(304, headers);
    return res.end();
  }

  let range = null;
  if (rangeHeader && ifRangeMatches(req, etag, mtimeMs)) {
    range = parseRange(rangeHeader, size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
      return res.end();
    }
  }

  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = range.end - range.start + 1;
  } else {
    headers['Content-Length'] = size;
  }
  const status = range ? 206 : 200;
  const hasBody = req.method !== 'HEAD' && !(range === null && size === 0);
  if (!hasBody) {
    res.writeHead(status, headers);
    return res.end();
  }
  // Open before the headers go out: a file that stats but cannot be opened (permissions, a
  // vanished file) is a proper 403/404/500 instead of an empty reply logged as a 200.
  let fh;
  try {
    fh = await fsp.open(absPath, 'r');
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return sendError(res, 404, 'not found');
    if (code === 'EACCES' || code === 'EPERM') return sendError(res, 403, 'cannot read file');
    return sendError(res, 500, `cannot read file: ${err && err.message ? err.message : err}`);
  }
  res.writeHead(status, headers);
  // pipeline() destroys the read stream (closing the handle) when either side closes, so a
  // download the phone abandons mid-way does not leak the file descriptor.
  const stream = fh.createReadStream(range ? { start: range.start, end: range.end } : {});
  pipeline(stream, res, () => {});
}

// Conditional GET: If-None-Match wins when present, else If-Modified-Since at the second
// precision that Last-Modified carries.
export function notModified(req, etag, mtimeMs) {
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

// If-Range: honour the Range header only when the validator still matches; otherwise the
// client gets the whole (changed) file with a 200.
function ifRangeMatches(req, etag, mtimeMs) {
  const value = req.headers['if-range'];
  if (!value) return true;
  if (value.startsWith('"') || value.startsWith('W/')) return value.trim() === etag;
  const t = Date.parse(value);
  return Number.isFinite(t) && Math.floor(mtimeMs / 1000) <= Math.floor(t / 1000);
}
