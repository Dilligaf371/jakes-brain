// JakeTube: a private YouTube over the PC's video folders. Channels come from
// cfg.videoChannels ({ id, name, paths, recursive }); nothing is uploaded or copied, the
// files are streamed from where they are.
//
//   GET /api/jaketube/channels                 -> [{ id, name, count }]
//   GET /api/jaketube/videos?channel=&q=       -> { videos: [...], scanned_at }   newest mtime first
//   GET /api/jaketube/videos/:id               -> { video }                        (with progress + path)
//   GET /api/jaketube/stream/:id               -> the file with Range support (what <video src> uses)
//   GET /api/jaketube/progress/:id             -> { progress: { seconds, duration, updated_at } | null }
//   PUT /api/jaketube/progress/:id {seconds, duration?} -> { progress }
//
// Scan: the channel folders are walked at most once per 60 s (on a channels/videos call);
// rows are upserted by id = sha1(realpath).slice(0, 16). Symlinks are followed and
// duplicates collapsed by realpath (a regular file's name wins over an alias's), the
// `latest.<ext>` alias is dropped, dotfiles and non-video extensions are skipped, missing
// folders are skipped silently, and rows whose file vanished are deleted (with their thumb).
// Duration/dimensions (ffprobe) and a 480px-wide JPEG thumb (ffmpeg, the frame at
// min(10 % of duration, 30 s)) into DATA/cache/jaketube/<id>.jpg are filled in lazily on the
// shared concurrency-1 tools queue after a list call; until then the list says thumb: null.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJsonBody, sendFile, HttpError } from '../http.js';

const EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm']);
const SCAN_TTL_MS = 60_000;
const MAX_DEPTH = 8;                       // recursive channels: how deep to follow folders
const ID_RE = /^[0-9a-f]{16}$/;
const CHANNEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const Q_MAX = 200;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const PROBE_TIMEOUT_MS = 30_000;
const THUMB_TIMEOUT_MS = 90_000;           // a 4K file on the PC: seeking + decoding one frame
const THUMB_WIDTH = 480;
const THUMB_MAX_OFFSET_S = 30;
const MAX_SECONDS = 10 * 24 * 3600;        // progress sanity cap (10 days)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default {
  id: 'jaketube',
  migrations: [
    {
      id: 'jaketube-1',
      sql: `
        CREATE TABLE IF NOT EXISTS tube_videos (
          id         TEXT    PRIMARY KEY,
          channel    TEXT    NOT NULL,
          path       TEXT    NOT NULL,
          name       TEXT    NOT NULL,
          size       INTEGER NOT NULL,
          mtime      TEXT    NOT NULL,
          duration   REAL,
          width      INTEGER,
          height     INTEGER,
          thumb      TEXT,
          probed_at  TEXT
        );
        CREATE INDEX IF NOT EXISTS tube_videos_channel_mtime ON tube_videos (channel, mtime DESC);
        CREATE TABLE IF NOT EXISTS tube_progress (
          video_id   TEXT PRIMARY KEY,
          seconds    REAL NOT NULL,
          duration   REAL,
          updated_at TEXT NOT NULL
        );
      `,
    },
  ],
  register(r, ctx) {
    const channels = readChannels(ctx.cfg, ctx.expandHome, ctx.log);
    const channelsById = new Map(channels.map((c) => [c.id, c]));
    const thumbDir = ctx.cacheDirFor('jaketube');
    const repo = videosRepo(ctx.db);
    const library = createLibrary({ channels, repo, thumbDir, tools: ctx.tools, log: ctx.log });
    ctx.log.info(`channels: ${channels.length ? channels.map((c) => c.id).join(', ') : '(none)'}; thumbs in ${thumbDir}`);

    // A row by id (400 on a malformed id, 404 when unknown). A deep link to a video the
    // database has not seen yet (fresh data dir) gets one scan before the 404.
    async function requireVideo(raw) {
      const id = String(raw == null ? '' : raw);
      if (!ID_RE.test(id)) throw new HttpError(400, 'bad video id');
      let row = repo.get(id);
      if (!row && !library.fresh()) {
        await library.ensureScan();
        row = repo.get(id);
      }
      if (!row) throw new HttpError(404, 'video not found');
      return row;
    }

    function toVideo(row, { withPath = false } = {}) {
      const ch = channelsById.get(row.channel);
      const version = row.probed_at ? (Date.parse(row.probed_at) || 0).toString(36) : '0';
      const video = {
        id: row.id,
        channel: row.channel,
        channel_name: ch ? ch.name : row.channel,
        name: row.name,
        title: readableName(row.name),
        size: Number(row.size),
        mtime: row.mtime,
        duration: row.duration == null ? null : Number(row.duration),
        width: row.width == null ? null : Number(row.width),
        height: row.height == null ? null : Number(row.height),
        thumb: row.thumb ? `/cache/jaketube/${row.thumb}?v=${version}` : null,
        probed: Boolean(row.probed_at),
        progress: progressOf(row),
      };
      if (withPath) video.path = row.path;
      return video;
    }

    r.get('/api/jaketube/channels', async () => {
      await library.ensureScan();
      const counts = repo.counts();
      library.scheduleProbes();
      return channels.map((c) => ({ id: c.id, name: c.name, count: counts.get(c.id) || 0 }));
    });

    r.get('/api/jaketube/videos', async (req, res, { query }) => {
      const channel = parseChannel(query.channel, channelsById);
      const q = parseQuery(query.q);
      await library.ensureScan();
      let videos = repo.list(channel).map((row) => toVideo(row));
      if (q) {
        const needle = q.toLowerCase();
        videos = videos.filter((v) => v.name.toLowerCase().includes(needle) || v.title.toLowerCase().includes(needle));
      }
      library.scheduleProbes();
      return { videos, scanned_at: library.scannedAt() };
    });

    r.get('/api/jaketube/videos/:id', async (req, res, { params }) => ({
      video: toVideo(await requireVideo(params.id), { withPath: true }),
    }));

    // The file itself. http.js sendFile does Range (206), If-Range, HEAD and 416, which is
    // what <video> needs to seek. The path came from our own scan, so no containment check
    // beyond that; a file that moved since is a 404 until the next scan drops the row.
    r.get('/api/jaketube/stream/:id', async (req, res, { params }) => {
      const row = await requireVideo(params.id);
      await sendFile(req, res, row.path, { cacheControl: 'private, max-age=3600' });
    });

    r.get('/api/jaketube/progress/:id', async (req, res, { params }) => {
      const row = await requireVideo(params.id);
      return { progress: progressOf(row) };
    });

    r.put('/api/jaketube/progress/:id', async (req, res, { params }) => {
      const row = await requireVideo(params.id);
      const body = await readJsonBody(req);
      const { seconds, duration } = validateProgress(body, row);
      return { progress: repo.putProgress(row.id, seconds, duration) };
    });
  },
};

// ---------------------------------------------------------------- config

// cfg.videoChannels -> [{ id, name, recursive, roots: [abs paths] }]; bad entries are logged and skipped.
function readChannels(cfg, expandHome, log) {
  const out = [];
  const seen = new Set();
  const raw = cfg && Array.isArray(cfg.videoChannels) ? cfg.videoChannels : [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.id == null ? '' : entry.id).trim();
    if (!CHANNEL_ID_RE.test(id) || seen.has(id)) {
      log.warn(`videoChannels: skipping an entry with a bad or duplicate id ${JSON.stringify(entry.id)}`);
      continue;
    }
    const paths = (Array.isArray(entry.paths) ? entry.paths : [entry.path]).filter((p) => typeof p === 'string' && p.trim());
    if (!paths.length) {
      log.warn(`videoChannels: channel "${id}" has no paths, skipped`);
      continue;
    }
    seen.add(id);
    out.push({
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
      recursive: entry.recursive === true,
      roots: paths.map((p) => path.resolve(expandHome(p.trim()))),
    });
  }
  return out;
}

function parseChannel(raw, channelsById) {
  if (raw === undefined || raw === null || raw === '') return '';
  const id = String(raw);
  if (!CHANNEL_ID_RE.test(id) || !channelsById.has(id)) throw new HttpError(400, 'unknown channel');
  return id;
}

function parseQuery(raw) {
  if (raw === undefined || raw === null) return '';
  const q = String(raw).replace(CONTROL_CHARS, '').trim();
  if (q.length > Q_MAX) throw new HttpError(400, `q is too long (max ${Q_MAX} characters)`);
  return q;
}

function validateProgress(body, row) {
  const seconds = body.seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new HttpError(400, 'seconds must be a number >= 0');
  if (seconds > MAX_SECONDS) throw new HttpError(400, 'seconds is out of range');
  let duration = null;
  if (body.duration !== undefined && body.duration !== null) {
    if (typeof body.duration !== 'number' || !Number.isFinite(body.duration) || body.duration <= 0) throw new HttpError(400, 'duration must be a positive number');
    duration = Math.min(body.duration, MAX_SECONDS);
  } else if (row.duration != null) {
    duration = Number(row.duration);
  }
  const clamped = duration != null ? Math.min(seconds, duration) : seconds;
  return { seconds: Math.round(clamped * 1000) / 1000, duration };
}

function progressOf(row) {
  if (row.p_seconds == null) return null;
  return {
    seconds: Number(row.p_seconds),
    duration: row.p_duration == null ? null : Number(row.p_duration),
    updated_at: row.p_updated_at,
  };
}

// "2026-10-15.mp4" -> "Oct 15, 2026"; "2026-10-15_19-07-48.mp4" -> "Oct 15, 2026 · 7:07 PM";
// anything else -> the stem. The web app formats the same names with the viewer's locale;
// this copy serves search (`q` matches the readable title too) and the graph.
export function readableName(name) {
  const stem = String(name == null ? '' : name).replace(/\.[^.]+$/, '');
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[_T ](\d{2})-(\d{2})-(\d{2}))?$/.exec(stem);
  if (!m) return stem;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hasTime = m[4] !== undefined;
  const [hour, minute, second] = hasTime ? [Number(m[4]), Number(m[5]), Number(m[6])] : [0, 0, 0];
  const probe = new Date(year, month - 1, day);
  const validDate = month >= 1 && month <= 12 && probe.getMonth() === month - 1 && probe.getDate() === day;
  if (!validDate || hour > 23 || minute > 59 || second > 59) return stem;
  const date = `${MONTHS[month - 1]} ${day}, ${year}`;
  if (!hasTime) return date;
  return `${date} · ${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

function idFor(realPath) {
  return crypto.createHash('sha1').update(realPath).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- scan + probe

function createLibrary({ channels, repo, thumbDir, tools, log }) {
  let scannedAt = 0;
  let inflight = null;
  const probing = new Set(); // ids queued or being probed right now

  const fresh = () => scannedAt > 0 && Date.now() - scannedAt < SCAN_TTL_MS;

  // Resolves once the scan is at most 60 s old; concurrent callers share one walk.
  function ensureScan() {
    if (inflight) return inflight;
    if (fresh()) return Promise.resolve(false);
    inflight = scan()
      .then(() => {
        scannedAt = Date.now();
        return true;
      })
      .catch((err) => {
        log.error('scan failed:', err && err.stack ? err.stack : err);
        return false;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  async function scan() {
    const found = new Map(); // id -> row fields
    for (const ch of channels) {
      for (const root of ch.roots) await walk(root, ch, 0, new Set(), found);
    }
    const staleThumbs = repo.sync(found);
    for (const thumb of staleThumbs) removeThumb(thumb);
  }

  // Files of a folder first (sorted, regular files before symlinks so a real file's name
  // beats an alias of it), then its sub-folders when the channel is recursive. Folder
  // symlinks are followed with a realpath guard against loops.
  async function walk(dir, ch, depth, visited, found) {
    let realDir;
    try {
      realDir = await fsp.realpath(dir);
    } catch {
      return; // missing folder: skipped silently (on the Mac none of them exist)
    }
    if (visited.has(realDir)) return;
    visited.add(realDir);
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = [];
    const dirs = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const isLink = entry.isSymbolicLink();
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      let st = null;
      if (isLink) {
        try {
          st = await fsp.stat(full); // follows the link; a dangling one is skipped
        } catch {
          continue;
        }
        isDir = st.isDirectory();
        isFile = st.isFile();
      }
      if (isDir) {
        dirs.push(full);
        continue;
      }
      if (!isFile) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!EXTENSIONS.has(ext)) continue;
      if (isLink && path.basename(entry.name, path.extname(entry.name)).toLowerCase() === 'latest') continue;
      files.push({ name: entry.name, full, isLink, st });
    }
    files.sort((a, b) => (Number(a.isLink) - Number(b.isLink)) || a.name.localeCompare(b.name));
    for (const file of files) {
      let realFile;
      let st = file.st;
      try {
        realFile = await fsp.realpath(file.full);
        if (!st) st = await fsp.stat(realFile);
      } catch {
        continue;
      }
      const id = idFor(realFile);
      if (found.has(id)) continue; // the same file under another name/channel: first wins
      found.set(id, { id, channel: ch.id, path: realFile, name: file.name, size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
    }
    if (ch.recursive && depth < MAX_DEPTH) {
      dirs.sort();
      for (const sub of dirs) await walk(sub, ch, depth + 1, visited, found);
    }
  }

  function removeThumb(name) {
    if (!name || typeof name !== 'string' || name.includes('/') || name.includes('\\')) return;
    fsp.rm(path.join(thumbDir, name), { force: true }).catch(() => {});
  }

  // Queue duration/dimension probes + thumbs for every row that has none, newest first (the
  // top of the list gets its thumbs first). Shared concurrency-1 queue: one ffmpeg at a time.
  function scheduleProbes() {
    if (!tools.ffprobe && !tools.ffmpeg) return;
    for (const row of repo.unprobed()) {
      if (probing.has(row.id)) continue;
      probing.add(row.id);
      tools.queue(() => probe(row.id))
        .catch((err) => log.error(`probe ${row.id} failed:`, err && err.stack ? err.stack : err))
        .finally(() => probing.delete(row.id));
    }
  }

  async function probe(id) {
    const row = repo.get(id);
    if (!row || row.probed_at) return;
    try {
      await fsp.stat(row.path);
    } catch {
      repo.remove(id); // vanished between the scan and now
      return;
    }
    const meta = tools.ffprobe ? await probeMeta(row.path) : {};
    const thumb = tools.ffmpeg ? await makeThumb(row, meta.duration) : null;
    repo.setProbed(id, { duration: meta.duration ?? null, width: meta.width ?? null, height: meta.height ?? null, thumb });
  }

  async function probeMeta(file) {
    const res = await tools.run(tools.ffprobe, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'v:0', file,
    ], { timeout: PROBE_TIMEOUT_MS });
    if (res.code !== 0) {
      log.warn(`ffprobe failed for ${file}: ${res.error || lastLine(res.stderr)}`);
      return {};
    }
    let data;
    try {
      data = JSON.parse(res.stdout);
    } catch {
      return {};
    }
    const stream = (Array.isArray(data.streams) && data.streams[0]) || {};
    const duration = finite(data.format && data.format.duration) ?? finite(stream.duration);
    let width = integer(stream.width);
    let height = integer(stream.height);
    if (width && height && Math.abs(rotationOf(stream)) % 180 === 90) [width, height] = [height, width];
    return { duration: duration != null && duration > 0 ? duration : null, width, height };
  }

  // One JPEG frame at min(10 % of the duration, 30 s), 480px wide, written to a .part file
  // and renamed so /cache never serves a half-written image. Falls back to the first frame.
  async function makeThumb(row, duration) {
    const name = `${row.id}.jpg`;
    const out = path.join(thumbDir, name);
    const tmp = path.join(thumbDir, `${row.id}.part.jpg`);
    const offset = duration ? Math.min(duration * 0.1, THUMB_MAX_OFFSET_S) : 0;
    const offsets = offset > 0 ? [offset, 0] : [0];
    for (const at of offsets) {
      const res = await tools.run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', at.toFixed(3), '-i', row.path,
        '-map', '0:v:0', '-an', '-frames:v', '1',
        '-vf', `scale=${THUMB_WIDTH}:-2`, '-pix_fmt', 'yuvj420p', '-q:v', '4',
        '-f', 'image2', tmp,
      ], { timeout: THUMB_TIMEOUT_MS });
      let ok = res.code === 0;
      if (ok) {
        try {
          ok = (await fsp.stat(tmp)).size > 0;
        } catch {
          ok = false;
        }
      }
      if (ok) {
        try {
          await fsp.rename(tmp, out);
          return name;
        } catch (err) {
          log.warn(`could not place thumb for ${row.path}: ${err.message}`);
          break;
        }
      }
      await fsp.rm(tmp, { force: true }).catch(() => {});
      if (res.code !== 0) log.warn(`ffmpeg thumb failed for ${row.path} at ${at.toFixed(1)} s: ${res.error || lastLine(res.stderr)}`);
    }
    return null;
  }

  return { ensureScan, scheduleProbes, fresh, scannedAt: () => (scannedAt ? new Date(scannedAt).toISOString() : null) };
}

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function integer(value) {
  const n = finite(value);
  return n != null && n > 0 ? Math.round(n) : null;
}

// Display-matrix rotation (new ffprobe: side_data_list[].rotation; old: tags.rotate).
function rotationOf(stream) {
  const list = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  for (const sd of list) {
    const r = finite(sd && sd.rotation);
    if (r != null) return r;
  }
  return finite(stream.tags && stream.tags.rotate) || 0;
}

function lastLine(text) {
  const lines = String(text || '').trim().split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1] : 'unknown error';
}

// ---------------------------------------------------------------- repository

function videosRepo(db) {
  const SELECT = `
    SELECT v.*, p.seconds AS p_seconds, p.duration AS p_duration, p.updated_at AS p_updated_at
    FROM tube_videos v LEFT JOIN tube_progress p ON p.video_id = v.id`;
  const listAllStmt = db.prepare(`${SELECT} ORDER BY v.mtime DESC, v.name DESC`);
  const listChannelStmt = db.prepare(`${SELECT} WHERE v.channel = ? ORDER BY v.mtime DESC, v.name DESC`);
  const getStmt = db.prepare(`${SELECT} WHERE v.id = ?`);
  const rowsStmt = db.prepare('SELECT id, channel, path, name, size, mtime, thumb FROM tube_videos');
  const unprobedStmt = db.prepare('SELECT id FROM tube_videos WHERE probed_at IS NULL ORDER BY mtime DESC');
  const countsStmt = db.prepare('SELECT channel, COUNT(*) AS n FROM tube_videos GROUP BY channel');
  const insertStmt = db.prepare('INSERT INTO tube_videos (id, channel, path, name, size, mtime) VALUES (?, ?, ?, ?, ?, ?)');
  const resetStmt = db.prepare(`
    UPDATE tube_videos SET channel = ?, path = ?, name = ?, size = ?, mtime = ?,
      duration = NULL, width = NULL, height = NULL, thumb = NULL, probed_at = NULL WHERE id = ?`);
  const renameStmt = db.prepare('UPDATE tube_videos SET channel = ?, path = ?, name = ? WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM tube_videos WHERE id = ?');
  const probedStmt = db.prepare('UPDATE tube_videos SET duration = ?, width = ?, height = ?, thumb = ?, probed_at = ? WHERE id = ?');
  const progressPutStmt = db.prepare(`
    INSERT INTO tube_progress (video_id, seconds, duration, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET seconds = excluded.seconds, duration = excluded.duration, updated_at = excluded.updated_at`);
  const progressGetStmt = db.prepare('SELECT seconds AS p_seconds, duration AS p_duration, updated_at AS p_updated_at FROM tube_progress WHERE video_id = ?');

  return {
    list: (channel) => (channel ? listChannelStmt.all(channel) : listAllStmt.all()),
    get: (id) => getStmt.get(id) || null,
    unprobed: () => unprobedStmt.all(),
    counts() {
      const out = new Map();
      for (const row of countsStmt.all()) out.set(String(row.channel), Number(row.n));
      return out;
    },
    // Upserts the scanned set and deletes the rest, in one transaction. A file whose size or
    // mtime changed loses its probe + thumb (it is re-probed lazily). Returns the thumb file
    // names that are now stale so the caller can delete them.
    sync(found) {
      const existing = new Map(rowsStmt.all().map((row) => [String(row.id), row]));
      const stale = [];
      db.exec('BEGIN');
      try {
        for (const v of found.values()) {
          const old = existing.get(v.id);
          if (!old) {
            insertStmt.run(v.id, v.channel, v.path, v.name, v.size, v.mtime);
          } else if (Number(old.size) !== v.size || old.mtime !== v.mtime) {
            resetStmt.run(v.channel, v.path, v.name, v.size, v.mtime, v.id);
            if (old.thumb) stale.push(old.thumb);
          } else if (old.channel !== v.channel || old.path !== v.path || old.name !== v.name) {
            renameStmt.run(v.channel, v.path, v.name, v.id);
          }
        }
        for (const old of existing.values()) {
          if (found.has(old.id)) continue;
          deleteStmt.run(old.id);
          if (old.thumb) stale.push(old.thumb);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return stale;
    },
    setProbed(id, { duration, width, height, thumb }) {
      probedStmt.run(duration ?? null, width ?? null, height ?? null, thumb ?? null, new Date().toISOString(), id);
    },
    remove: (id) => Number(deleteStmt.run(id).changes) > 0,
    putProgress(id, seconds, duration) {
      progressPutStmt.run(id, seconds, duration ?? null, new Date().toISOString());
      return progressOf(progressGetStmt.get(id));
    },
  };
}
