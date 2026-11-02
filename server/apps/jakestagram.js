// Jakestagram: Jake's private Instagram. Photos and videos uploaded from the phone land in
// DATA/media/jakestagram/, get a 720px JPEG thumbnail (poster frame for videos) via ffmpeg
// when it exists, and are listed newest-first with a heart and a caption.
//
//   PUT    /api/jakestagram/upload              raw image/* or video/* body (<= 300 MB), header X-Filename
//                                               -> 201 { upload: { file, thumb, kind, width, height, size } }
//   POST   /api/jakestagram/posts               { file, thumb, kind, width, height, caption } -> 201 { post }
//   GET    /api/jakestagram/posts?before=&limit=  newest first; `before=<id>` pages (exclusive),
//                                               `from=<id>` starts at that post (inclusive) -> { posts, more }
//   GET    /api/jakestagram/posts/:id           -> { post }
//   PATCH  /api/jakestagram/posts/:id           { caption?, liked? } -> { post }
//   DELETE /api/jakestagram/posts/:id           -> 204, removes the file and its thumb
//   GET    /api/jakestagram/stats               -> { posts, liked, images, videos }
//
// Files are named `<local timestamp>_<6 hex>.<ext>` (the "upload id"); the thumb is `<id>_t.jpg`
// next to it. An upload that is never turned into a post is swept after 24 h.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readJsonBody, saveRawBody, requestFilename, sendJson, sendEmpty, HttpError } from '../http.js';

const MAX_UPLOAD = 300 * 1024 * 1024;
const CAPTION_MAX = 2200;
const PAGE_DEFAULT = 20;
const PAGE_MAX = 100;
const THUMB_WIDTH = 720;
const DIM_MAX = 32767;
const ORPHAN_AGE_MS = 24 * 3600 * 1000;
const SWEEP_EVERY_MS = 6 * 3600 * 1000;
const HEADER_BYTES = 512 * 1024; // enough JPEG to reach the SOF marker past big EXIF/thumbnail segments

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v']);
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/pjpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heic', 'image/heic-sequence': 'heic',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v',
};
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.(jpg|jpeg|png|gif|webp|heic|mp4|mov|m4v)$/;
// C0 controls other than \t \n, plus DEL: a NUL would truncate the caption on read.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export default {
  id: 'jakestagram',
  migrations: [
    {
      id: 'jakestagram-1',
      sql: `
        CREATE TABLE IF NOT EXISTS gram_posts (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          kind       TEXT    NOT NULL CHECK (kind IN ('image', 'video')),
          file       TEXT    NOT NULL UNIQUE,
          thumb      TEXT,
          width      INTEGER,
          height     INTEGER,
          caption    TEXT    NOT NULL DEFAULT '',
          liked      INTEGER NOT NULL DEFAULT 0,
          created_at TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS gram_posts_created ON gram_posts (created_at DESC, id DESC);
      `,
    },
  ],
  register(r, ctx) {
    const { db, tools, log } = ctx;
    const mediaDir = ctx.mediaDir('jakestagram');
    const repo = postsRepo(db);
    const media = mediaOps({ mediaDir, tools, log });

    r.put('/api/jakestagram/upload', async (req, res) => {
      const { kind, ext } = classify(req);
      const id = newId();
      const file = `${id}.${ext}`;
      const finalPath = path.join(mediaDir, file);
      const partPath = path.join(mediaDir, `.${file}.part`); // a dotfile: invisible under /media until it is whole
      const { bytes } = await saveRawBody(req, partPath, { limit: MAX_UPLOAD });
      if (!bytes) {
        await rmQuiet(partPath);
        throw new HttpError(400, 'empty body');
      }
      await fsp.rename(partPath, finalPath);
      let derived = { thumb: null, width: null, height: null };
      try {
        derived = await media.derive(finalPath, kind, id);
      } catch (err) {
        log.warn(`thumb/dimensions failed for ${file}: ${err && err.message ? err.message : err}`);
      }
      sendJson(res, 201, { upload: { file, thumb: derived.thumb, kind, width: derived.width, height: derived.height, size: bytes } });
    });

    r.get('/api/jakestagram/posts', (req, res, { query }) => {
      const limit = parseLimit(query.limit);
      const before = query.before === undefined ? null : parseIdStrict(query.before, 'before');
      const from = query.from === undefined ? null : parseIdStrict(query.from, 'from');
      const rows = repo.list({ before, from, limit: limit + 1 });
      const more = rows.length > limit;
      return { posts: rows.slice(0, limit), more };
    });

    r.get('/api/jakestagram/stats', () => repo.stats());

    r.post('/api/jakestagram/posts', async (req, res) => {
      const body = await readJsonBody(req);
      const input = validateNewPost(body, mediaDir);
      if (repo.byFile(input.file)) throw new HttpError(409, 'that file is already posted');
      sendJson(res, 201, { post: repo.create(input) });
    });

    r.get('/api/jakestagram/posts/:id', (req, res, { params }) => {
      const post = repo.get(parseId(params.id));
      if (!post) throw new HttpError(404, 'post not found');
      return { post };
    });

    r.patch('/api/jakestagram/posts/:id', async (req, res, { params }) => {
      const id = parseId(params.id);
      if (!repo.get(id)) throw new HttpError(404, 'post not found');
      const body = await readJsonBody(req);
      const patch = {};
      if (body.caption !== undefined) patch.caption = validateCaption(body.caption);
      if (body.liked !== undefined) {
        if (typeof body.liked !== 'boolean') throw new HttpError(400, 'liked must be a boolean');
        patch.liked = body.liked;
      }
      if (patch.caption === undefined && patch.liked === undefined) {
        throw new HttpError(400, 'nothing to update: send caption and/or liked');
      }
      const post = repo.update(id, patch);
      if (!post) throw new HttpError(404, 'post not found');
      return { post };
    });

    r.delete('/api/jakestagram/posts/:id', async (req, res, { params }) => {
      const post = repo.get(parseId(params.id));
      if (!post) throw new HttpError(404, 'post not found');
      repo.remove(post.id);
      // The thumb by name even when the post was saved with thumb: null, so nothing lingers.
      await media.removeFiles([post.file, post.thumb, `${post.file.slice(0, post.file.lastIndexOf('.'))}_t.jpg`]);
      sendEmpty(res, 204);
    });

    // Uploads that never became a post (the phone died mid-compose) are swept once they are
    // a day old; deferred so startup stays instant, unref'd so it never keeps the process alive.
    const sweep = () => media.sweepOrphans(repo.referencedFiles()).catch((err) => log.warn(`orphan sweep failed: ${err.message}`));
    setTimeout(sweep, 15_000).unref();
    setInterval(sweep, SWEEP_EVERY_MS).unref();
  },
};

// ---------------------------------------------------------------- validation

// Kind + extension from Content-Type and X-Filename. 415 when neither says image/video,
// 400 when they disagree ("x.mov" sent as image/jpeg).
function classify(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const name = requestFilename(req);
  const dot = name ? name.lastIndexOf('.') : -1;
  const nameExt = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const extKind = IMAGE_EXT.has(nameExt) ? 'image' : VIDEO_EXT.has(nameExt) ? 'video' : null;
  const typeKind = type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : null;
  if (!typeKind && !extKind) {
    throw new HttpError(415, 'unsupported file type: send an image/* or video/* body (jpg, png, gif, webp, heic, mp4, mov, m4v)');
  }
  if (typeKind && extKind && typeKind !== extKind) throw new HttpError(400, `file type mismatch: ${type} with .${nameExt}`);
  const kind = typeKind || extKind;
  const ext = extKind ? nameExt : MIME_EXT[type];
  if (!ext) throw new HttpError(415, `unsupported ${kind} type ${type} (jpg, png, gif, webp, heic, mp4, mov, m4v)`);
  return { kind, ext, name };
}

function newId() {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
  return `${stamp}_${randomBytes(3).toString('hex')}`;
}

function parseId(raw) {
  if (!/^\d{1,15}$/.test(String(raw))) return 0;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function parseIdStrict(raw, name) {
  const id = parseId(raw);
  if (!id) throw new HttpError(400, `${name} must be a positive integer id`);
  return id;
}

function parseLimit(raw) {
  if (raw === undefined || raw === '') return PAGE_DEFAULT;
  if (!/^\d{1,4}$/.test(String(raw))) throw new HttpError(400, 'limit must be a positive integer');
  return Math.min(PAGE_MAX, Math.max(1, Number(raw)));
}

function validateCaption(caption) {
  if (caption === null || caption === undefined) return '';
  if (typeof caption !== 'string') throw new HttpError(400, 'caption must be a string');
  const clean = caption.replace(/\r\n?/g, '\n').trim();
  if (clean.length > CAPTION_MAX) throw new HttpError(400, `caption is too long (max ${CAPTION_MAX} characters)`);
  if (CONTROL_CHARS.test(clean)) throw new HttpError(400, 'caption contains control characters');
  return clean;
}

function validateDim(value, name) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > DIM_MAX) throw new HttpError(400, `${name} must be a positive integer`);
  return value;
}

function validateNewPost(body, mediaDir) {
  const file = body.file;
  if (typeof file !== 'string' || !FILE_RE.test(file) || path.basename(file) !== file) {
    throw new HttpError(400, 'file must be the name returned by the upload');
  }
  if (!isFileSync(path.join(mediaDir, file))) throw new HttpError(400, 'file not found: upload it first');
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  const fileKind = IMAGE_EXT.has(ext) ? 'image' : 'video';
  if (body.kind !== 'image' && body.kind !== 'video') throw new HttpError(400, "kind must be 'image' or 'video'");
  if (body.kind !== fileKind) throw new HttpError(400, `kind ${body.kind} does not match .${ext}`);
  let thumb = null;
  if (body.thumb !== null && body.thumb !== undefined) {
    const expected = `${file.slice(0, file.lastIndexOf('.'))}_t.jpg`;
    if (typeof body.thumb !== 'string' || body.thumb !== expected) throw new HttpError(400, 'thumb must be the name returned by the upload (or null)');
    if (!isFileSync(path.join(mediaDir, body.thumb))) throw new HttpError(400, 'thumb not found');
    thumb = body.thumb;
  }
  return {
    file,
    thumb,
    kind: body.kind,
    width: validateDim(body.width, 'width'),
    height: validateDim(body.height, 'height'),
    caption: validateCaption(body.caption),
  };
}

function isFileSync(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

async function rmQuiet(file) {
  try {
    await fsp.rm(file, { force: true });
  } catch { /* already gone */ }
}

// ---------------------------------------------------------------- media (thumbs, dimensions, cleanup)

function mediaOps({ mediaDir, tools, log }) {
  async function fileSize(file) {
    try {
      return (await fsp.stat(file)).size;
    } catch {
      return 0;
    }
  }

  // One ffmpeg at a time (tools.queue). Images: first frame scaled to <= 720 px wide.
  // Videos: the frame at 1 s, falling back to the first frame for clips shorter than that.
  async function renderThumb(src, kind, out) {
    if (!tools.ffmpeg) return false;
    const vf = `scale='min(${THUMB_WIDTH},iw)':-2,format=yuvj420p`;
    const seeks = kind === 'video' ? [['-ss', '1'], ['-ss', '0']] : [[]];
    for (const seek of seeks) {
      const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...seek, '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '3', '-f', 'image2', out];
      const result = await tools.queue(() => tools.run(tools.ffmpeg, args, { timeout: 90_000 }));
      if (result.code === 0 && (await fileSize(out)) > 0) return true;
      await rmQuiet(out);
      if (result.error) {
        log.warn(`ffmpeg could not run: ${result.error}`);
        return false;
      }
      const reason = (result.stderr || '').trim().split('\n').pop() || `exit ${result.code}`;
      log.warn(`thumb failed for ${path.basename(src)}: ${reason}`);
    }
    return false;
  }

  // Width/height of the first video stream, rotation applied (a portrait iPhone clip is
  // stored 1920x1080 with a -90° display matrix).
  async function probeDims(src) {
    if (!tools.ffprobe) return null;
    const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_tags=rotate:stream_side_data=rotation', '-of', 'json', src];
    const result = await tools.run(tools.ffprobe, args, { timeout: 30_000 });
    if (result.code !== 0) return null;
    let stream;
    try {
      stream = (JSON.parse(result.stdout).streams || [])[0];
    } catch {
      return null;
    }
    if (!stream) return null;
    let width = Number(stream.width);
    let height = Number(stream.height);
    if (!(width > 0 && height > 0)) return null;
    let rotation = 0;
    for (const side of stream.side_data_list || []) if (side && Number.isFinite(Number(side.rotation))) rotation = Number(side.rotation);
    if (!rotation && stream.tags && Number.isFinite(Number(stream.tags.rotate))) rotation = Number(stream.tags.rotate);
    if (Math.abs(Math.round(rotation)) % 180 === 90) [width, height] = [height, width];
    return { width: Math.round(width), height: Math.round(height) };
  }

  async function headerDimsOf(src) {
    let fh;
    try {
      fh = await fsp.open(src, 'r');
      const buf = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0);
      return headerDims(buf.subarray(0, bytesRead));
    } catch {
      return null;
    } finally {
      if (fh) await fh.close();
    }
  }

  return {
    async derive(src, kind, id) {
      let dims = await probeDims(src);
      if (!dims && kind === 'image') dims = await headerDimsOf(src); // no ffprobe: read the image header
      const thumbName = `${id}_t.jpg`;
      const ok = await renderThumb(src, kind, path.join(mediaDir, thumbName));
      return { thumb: ok ? thumbName : null, width: dims ? dims.width : null, height: dims ? dims.height : null };
    },

    async removeFiles(names) {
      for (const name of names) {
        if (!name || typeof name !== 'string' || path.basename(name) !== name) continue;
        try {
          await fsp.rm(path.join(mediaDir, name), { force: true });
        } catch (err) {
          log.warn(`could not remove ${name}: ${err.message}`);
        }
      }
    },

    async sweepOrphans(referenced) {
      let names;
      try {
        names = await fsp.readdir(mediaDir);
      } catch {
        return 0;
      }
      let removed = 0;
      const cutoff = Date.now() - ORPHAN_AGE_MS;
      for (const name of names) {
        if (referenced.has(name)) continue;
        const file = path.join(mediaDir, name);
        try {
          const st = await fsp.stat(file);
          if (!st.isFile() || st.mtimeMs > cutoff) continue;
          await fsp.rm(file, { force: true });
          removed += 1;
        } catch { /* vanished mid-sweep */ }
      }
      if (removed) log.info(`removed ${removed} orphaned upload${removed === 1 ? '' : 's'}`);
      return removed;
    },
  };
}

// Pixel size from the first bytes of a PNG / GIF / WebP / JPEG (used only when ffprobe is
// missing). EXIF orientation is not applied. Returns { width, height } or null.
export function headerDims(buf) {
  if (!buf || buf.length < 10) return null;
  const ascii = (a, b) => buf.toString('latin1', a, b);
  if (buf.length >= 24 && buf[0] === 0x89 && ascii(1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (ascii(0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const chunk = ascii(12, 16);
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan: no frame header found
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      if (len < 2) break;
      i += 2 + len;
    }
  }
  return null;
}

// ---------------------------------------------------------------- repository

function rowToPost(row) {
  return {
    id: Number(row.id),
    kind: row.kind,
    file: row.file,
    thumb: row.thumb || null,
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    caption: row.caption || '',
    liked: Boolean(row.liked),
    created_at: row.created_at,
  };
}

function postsRepo(db) {
  const getStmt = db.prepare('SELECT * FROM gram_posts WHERE id = ?');
  const byFileStmt = db.prepare('SELECT id FROM gram_posts WHERE file = ?');
  const listStmt = db.prepare('SELECT * FROM gram_posts ORDER BY id DESC LIMIT ?');
  const beforeStmt = db.prepare('SELECT * FROM gram_posts WHERE id < ? ORDER BY id DESC LIMIT ?');
  const fromStmt = db.prepare('SELECT * FROM gram_posts WHERE id <= ? ORDER BY id DESC LIMIT ?');
  const insertStmt = db.prepare('INSERT INTO gram_posts (kind, file, thumb, width, height, caption, liked, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)');
  const updateStmt = db.prepare('UPDATE gram_posts SET caption = ?, liked = ? WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM gram_posts WHERE id = ?');
  const filesStmt = db.prepare('SELECT file, thumb FROM gram_posts');
  const statsStmt = db.prepare(`
    SELECT COUNT(*) AS posts,
           COALESCE(SUM(liked), 0) AS liked,
           COALESCE(SUM(kind = 'image'), 0) AS images,
           COALESCE(SUM(kind = 'video'), 0) AS videos
    FROM gram_posts
  `);

  const get = (id) => {
    if (!id) return null;
    const row = getStmt.get(id);
    return row ? rowToPost(row) : null;
  };

  return {
    get,
    byFile: (file) => byFileStmt.get(file) || null,
    // Ids only grow with time, so `id DESC` is newest-first and paging by id is stable.
    list({ before = null, from = null, limit = PAGE_DEFAULT } = {}) {
      let rows;
      if (before) rows = beforeStmt.all(before, limit);
      else if (from) rows = fromStmt.all(from, limit);
      else rows = listStmt.all(limit);
      return rows.map(rowToPost);
    },
    stats() {
      const row = statsStmt.get();
      return { posts: Number(row.posts), liked: Number(row.liked), images: Number(row.images), videos: Number(row.videos) };
    },
    create({ file, thumb, kind, width, height, caption }) {
      const info = insertStmt.run(kind, file, thumb, width, height, caption, new Date().toISOString());
      return get(Number(info.lastInsertRowid));
    },
    update(id, patch) {
      const current = get(id);
      if (!current) return null;
      const caption = patch.caption !== undefined ? patch.caption : current.caption;
      const liked = patch.liked !== undefined ? patch.liked : current.liked;
      updateStmt.run(caption, liked ? 1 : 0, id);
      return get(id);
    },
    remove(id) {
      return Number(deleteStmt.run(id).changes) > 0;
    },
    referencedFiles() {
      const set = new Set();
      for (const row of filesStmt.all()) {
        set.add(row.file);
        if (row.thumb) set.add(row.thumb);
      }
      return set;
    },
  };
}
