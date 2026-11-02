// Files: a read-only browser of the PC folders listed in config.json `fileRoots`
// ([{ name, path }], `~` expands to the server user's home). No tables. Routes:
//   GET /api/files/roots                        -> [{ name, exists }]
//   GET /api/files/list?root=<name>&path=<rel>  -> { root, path, entries: [{ name, kind, size, mtime, ext, count? }], truncated }
//   GET /api/files/get?root=<name>&path=<rel>   -> the file, inline, with Range support (video seeking)
//   GET /api/files/text?root=<name>&path=<rel>  -> { text, truncated, size }   first 200 KB of a text-ish file
//
// Containment: `path` is relative, split on '/', with '', '.' dropped; '..', NUL / control
// characters and an absolute path are a 400 before anything touches the disk. Then
// realpath(root) and realpath(root/path) are resolved and the latter must equal the former
// or start with it + '/', else 400 (a symlink that points out of the root). A missing root or
// path is a 404; a root name that is not configured is a 404. Dotfiles are hidden everywhere:
// never listed, and a path that names one is a 404.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError, sendFile, mimeFor } from '../http.js';

const TEXT_MAX_BYTES = 200 * 1024;
// Listing caps: entries per folder (a 50k-file folder is useless on a phone anyway), and
// how many subfolders get an item count (one readdir each) before the rest get count: null.
const ENTRY_CAP = 5000;
const DIR_COUNT_LIMIT = 400;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'json', 'jsonl', 'ndjson', 'log', 'csv', 'tsv', 'yaml', 'yml',
  'xml', 'html', 'htm', 'xhtml', 'css', 'js', 'mjs', 'cjs', 'ts', 'py', 'sh', 'bash', 'zsh', 'fish',
  'toml', 'ini', 'cfg', 'conf', 'config', 'env', 'sql', 'srt', 'vtt', 'ass', 'rst', 'tex', 'bib',
  'c', 'h', 'cc', 'cpp', 'hpp', 'java', 'kt', 'swift', 'rb', 'go', 'rs', 'php', 'pl', 'lua', 'r',
  'm', 'mm', 'plist', 'service', 'desktop', 'diff', 'patch', 'properties', 'gitignore', 'editorconfig',
  'nfo', 'lrc', 'cue', 'm3u', 'm3u8', 'svg',
]);
// Extension-less files that are text by convention.
const TEXT_NAMES = new Set(['readme', 'license', 'licence', 'copying', 'makefile', 'changelog', 'dockerfile', 'authors', 'notice', 'todo', 'version']);
// Served as plain text: an HTML file in ~/Downloads must never run as a document on the app's origin.
const PLAIN_TEXT_EXT = new Set(['.html', '.htm', '.xhtml']);

export default {
  id: 'files',
  migrations: [
    // The spec gives this app no tables; the row only records that the module is installed.
    { id: 'files-1', sql: '-- files: read-only folder browser, no tables' },
  ],
  register(r, ctx) {
    const roots = loadRoots(ctx);
    const resolve = (query, want) => resolveTarget(roots, query, want);

    r.get('/api/files/roots', async () => Promise.all(roots.map(async (root) => ({ name: root.name, exists: await isDirectory(root.dir) }))));

    r.get('/api/files/list', async (req, res, { query }) => {
      const target = await resolve(query, 'dir');
      const { entries, truncated } = await listDirectory(target.real, target.realRoot);
      return { root: target.root.name, path: target.rel, entries, truncated };
    });

    r.get('/api/files/get', async (req, res, { query }) => {
      const target = await resolve(query, 'file');
      // Belt and braces for a direct navigation to the URL: no scripts, opaque origin.
      res.setHeader('Content-Security-Policy', 'sandbox');
      await sendFile(req, res, target.real, { stat: target.stat, cacheControl: 'no-cache', contentType: contentTypeFor(target.real) });
    });

    r.get('/api/files/text', async (req, res, { query }) => {
      const target = await resolve(query, 'file');
      if (!isTextish(path.basename(target.real))) throw new HttpError(400, 'not a text file');
      return readTextHead(target.real, target.stat.size);
    });
  },
};

// ---------------------------------------------------------------- roots

// cfg.fileRoots -> [{ name, dir }]; bad entries are skipped with a warning, the first of two
// roots with the same name wins. The directories need not exist (GET /roots says so).
function loadRoots(ctx) {
  const list = Array.isArray(ctx.cfg && ctx.cfg.fileRoots) ? ctx.cfg.fileRoots : [];
  const roots = [];
  const seen = new Set();
  for (const entry of list) {
    const name = entry && typeof entry.name === 'string' ? entry.name.trim() : '';
    const raw = entry && typeof entry.path === 'string' ? entry.path.trim() : '';
    if (!name || !raw || name.includes('/') || CONTROL_CHARS.test(name)) {
      ctx.log.warn(`fileRoots: skipping ${JSON.stringify(entry)} (needs a name without "/" and a path)`);
      continue;
    }
    if (seen.has(name)) {
      ctx.log.warn(`fileRoots: duplicate root name "${name}" ignored (${raw})`);
      continue;
    }
    seen.add(name);
    roots.push({ name, dir: path.resolve(ctx.expandHome(raw)) });
  }
  ctx.log(`roots: ${roots.length ? roots.map((root) => `${root.name} -> ${root.dir}`).join(', ') : '(none configured)'}`);
  return roots;
}

async function isDirectory(dir) {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- containment

// The relative path as clean segments. Throws 400 for anything that is not a plain relative
// path; a segment that starts with '.' (a dotfile) is reported as missing (404) by the caller.
function parseRelative(raw) {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'string') throw new HttpError(400, 'path must be a string');
  if (CONTROL_CHARS.test(raw)) throw new HttpError(400, 'path contains control characters');
  if (raw.length > 4096) throw new HttpError(400, 'path is too long');
  if (raw.startsWith('/') || raw.startsWith('\\')) throw new HttpError(400, 'path must be relative');
  const segments = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw new HttpError(400, 'path must stay inside the root');
    segments.push(segment);
  }
  return segments;
}

// Resolves ?root=&path= to a real path inside the root. `want` is 'dir' or 'file'.
// Returns { root, rel, realRoot, real, stat }.
async function resolveTarget(roots, query, want) {
  const name = typeof query.root === 'string' ? query.root : '';
  if (!name) throw new HttpError(400, 'root is required');
  const root = roots.find((candidate) => candidate.name === name);
  if (!root) throw new HttpError(404, 'root not found');
  const segments = parseRelative(query.path);
  if (segments.some((segment) => segment.startsWith('.'))) throw new HttpError(404, 'not found');

  let realRoot;
  try {
    realRoot = await fsp.realpath(root.dir);
  } catch {
    throw new HttpError(404, 'root folder does not exist');
  }
  if (!(await isDirectory(realRoot))) throw new HttpError(404, 'root folder does not exist');

  const lexical = path.resolve(realRoot, ...segments);
  if (!isInside(lexical, realRoot)) throw new HttpError(400, 'path must stay inside the root');

  let real;
  try {
    real = await fsp.realpath(lexical);
  } catch (err) {
    throw fsError(err);
  }
  if (!isInside(real, realRoot)) throw new HttpError(400, 'path must stay inside the root');

  let stat;
  try {
    stat = await fsp.stat(real);
  } catch (err) {
    throw fsError(err);
  }
  if (want === 'dir' && !stat.isDirectory()) throw new HttpError(400, 'not a directory');
  if (want === 'file' && !stat.isFile()) throw new HttpError(400, 'not a file');
  return { root, rel: segments.join('/'), realRoot, real, stat };
}

function isInside(candidate, realRoot) {
  return candidate === realRoot || candidate.startsWith(realRoot + path.sep);
}

function fsError(err) {
  const code = err && err.code;
  if (code === 'EACCES' || code === 'EPERM') return new HttpError(403, 'cannot read that path');
  if (code === 'ENAMETOOLONG') return new HttpError(400, 'path is too long');
  if (code === 'ELOOP') return new HttpError(400, 'symlink loop');
  return new HttpError(404, 'not found');
}

// ---------------------------------------------------------------- listing

// Dirs first, then natural alphabetical. Dotfiles hidden; symlinks followed, but an entry
// whose real path leaves the root is left out (the API would refuse it anyway); broken
// links and special files (sockets, fifos) are skipped.
async function listDirectory(dir, realRoot) {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw fsError(err);
  }
  const visible = dirents.filter((d) => !d.name.startsWith('.'));
  const truncated = visible.length > ENTRY_CAP;
  const picked = truncated ? visible.slice(0, ENTRY_CAP) : visible;
  const stats = await Promise.all(picked.map(async (dirent) => {
    const full = path.join(dir, dirent.name);
    let target = full;
    if (dirent.isSymbolicLink()) {
      try {
        target = await fsp.realpath(full);
      } catch {
        return null;
      }
      if (!isInside(target, realRoot)) return null;
    }
    let st;
    try {
      st = await fsp.stat(target);
    } catch {
      return null;
    }
    if (st.isDirectory()) return { name: dirent.name, kind: 'dir', size: 0, mtime: st.mtime.toISOString(), ext: '', target };
    if (st.isFile()) return { name: dirent.name, kind: 'file', size: st.size, mtime: st.mtime.toISOString(), ext: extOf(dirent.name) };
    return null;
  }));
  const entries = stats.filter(Boolean).sort(compareEntries);
  let counted = 0;
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue;
    entry.count = counted < DIR_COUNT_LIMIT ? await countVisible(entry.target) : null;
    counted += 1;
    delete entry.target;
  }
  return { entries, truncated };
}

function compareEntries(a, b) {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

async function countVisible(dir) {
  try {
    return (await fsp.readdir(dir)).filter((name) => !name.startsWith('.')).length;
  } catch {
    return null;
  }
}

function extOf(name) {
  return path.extname(name).slice(1).toLowerCase();
}

// ---------------------------------------------------------------- files

function isTextish(name) {
  const ext = extOf(name);
  if (ext) return TEXT_EXT.has(ext);
  return TEXT_NAMES.has(name.toLowerCase());
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (PLAIN_TEXT_EXT.has(ext)) return 'text/plain; charset=utf-8';
  const type = mimeFor(file);
  // Text-ish files the MIME table does not know (yaml, py, sh, ...) are text, not downloads.
  if (type === 'application/octet-stream' && isTextish(path.basename(file))) return 'text/plain; charset=utf-8';
  return type;
}

// The first 200 KB decoded as UTF-8. `stream: true` on a truncated read keeps the decoder
// from emitting U+FFFD for a multi-byte character cut at the boundary.
async function readTextHead(file, size) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
  } catch (err) {
    throw fsError(err);
  }
  try {
    const want = Math.min(Math.max(0, size), TEXT_MAX_BYTES);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, want - got, got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    const truncated = size > TEXT_MAX_BYTES;
    const text = new TextDecoder('utf-8').decode(buf.subarray(0, got), { stream: truncated });
    return { text, truncated, size };
  } finally {
    await fh.close();
  }
}
