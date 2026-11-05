// Capture: a frictionless inbox. The owner, ICO or Claude POSTs a raw thought/note/anything;
// it lands here unprocessed, to be triaged later. Routes:
//   GET    /api/capture                 -> { items: [...] }   unprocessed first, newest first
//   POST   /api/capture {text, kind?, source?} -> 201 { item }
//   PATCH  /api/capture/:id {text?, processed?} -> { item }
//   DELETE /api/capture/:id             -> 204
//   GET    /api/capture/badge           -> { count: <unprocessed> }
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';

const TEXT_MAX = 4000;
const TAG_MAX = 80;
// C0 controls other than \t \n \r, plus DEL. node:sqlite hands text back as a C string, so
// a NUL would silently truncate the row on read; the rest never belong in one.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// Zero-width characters that make text look empty. Only used for the emptiness check:
// U+200D stays in stored text because emoji ZWJ sequences need it.
const INVISIBLE = /[​‌‍⁠﻿]/g;

export default {
  id: 'capture',
  migrations: [
    {
      id: 'capture-1',
      sql: `
        CREATE TABLE IF NOT EXISTS captures (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          text       TEXT    NOT NULL,
          kind       TEXT,
          source     TEXT,
          processed  INTEGER NOT NULL DEFAULT 0,
          created_at TEXT    NOT NULL,
          updated_at TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS captures_processed_created ON captures (processed, created_at DESC);
      `,
    },
  ],
  register(r, ctx) {
    const repo = captureRepo(ctx.db);

    r.get('/api/capture', () => ({ items: repo.list() }));

    r.get('/api/capture/badge', () => ({ count: repo.unprocessedCount() }));

    r.post('/api/capture', async (req, res) => {
      const body = await readJsonBody(req);
      const item = repo.create(validateText(body.text), validateTag(body.kind, 'kind'), validateTag(body.source, 'source'));
      sendJson(res, 201, { item });
    });

    r.get('/api/capture/:id', (req, res, { params }) => {
      const item = repo.get(parseId(params.id));
      if (!item) throw new HttpError(404, 'capture not found');
      return { item };
    });

    r.patch('/api/capture/:id', async (req, res, { params }) => {
      // Resolve first so a missing id is a 404 whatever the body says.
      const id = parseId(params.id);
      if (!repo.get(id)) throw new HttpError(404, 'capture not found');
      const body = await readJsonBody(req);
      const patch = {};
      if (body.text !== undefined) patch.text = validateText(body.text);
      if (body.processed !== undefined) {
        if (typeof body.processed !== 'boolean') throw new HttpError(400, 'processed must be a boolean');
        patch.processed = body.processed;
      }
      if (patch.text === undefined && patch.processed === undefined) {
        throw new HttpError(400, 'nothing to update: send text and/or processed');
      }
      const item = repo.update(id, patch);
      if (!item) throw new HttpError(404, 'capture not found');
      return { item };
    });

    r.delete('/api/capture/:id', (req, res, { params }) => {
      if (!repo.remove(parseId(params.id))) throw new HttpError(404, 'capture not found');
      sendEmpty(res, 204);
    });
  },
};

function parseId(raw) {
  if (!/^\d{1,15}$/.test(String(raw))) return 0;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function validateText(text) {
  if (typeof text !== 'string') throw new HttpError(400, 'text must be a string');
  const trimmed = text.trim();
  if (!trimmed || !trimmed.replace(INVISIBLE, '').trim()) throw new HttpError(400, 'text is required');
  if (trimmed.length > TEXT_MAX) throw new HttpError(400, `text is too long (max ${TEXT_MAX} characters)`);
  if (CONTROL_CHARS.test(trimmed)) throw new HttpError(400, 'text contains control characters');
  return trimmed;
}

// kind / source are optional short tags; absent, null or empty means "none" (stored as null).
function validateTag(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > TAG_MAX) throw new HttpError(400, `${field} is too long (max ${TAG_MAX} characters)`);
  if (CONTROL_CHARS.test(trimmed)) throw new HttpError(400, `${field} contains control characters`);
  return trimmed;
}

function rowToItem(row) {
  return {
    id: Number(row.id),
    text: row.text,
    kind: row.kind,
    source: row.source,
    processed: Boolean(row.processed),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function captureRepo(db) {
  const listStmt = db.prepare('SELECT * FROM captures ORDER BY processed ASC, created_at DESC, id DESC');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM captures WHERE processed = 0');
  const getStmt = db.prepare('SELECT * FROM captures WHERE id = ?');
  const insertStmt = db.prepare('INSERT INTO captures (text, kind, source, processed, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)');
  const updateStmt = db.prepare('UPDATE captures SET text = ?, processed = ?, updated_at = ? WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM captures WHERE id = ?');

  const get = (id) => {
    if (!id) return null;
    const row = getStmt.get(id);
    return row ? rowToItem(row) : null;
  };

  return {
    list: () => listStmt.all().map(rowToItem),
    unprocessedCount: () => Number(countStmt.get().n),
    get,
    create(text, kind, source) {
      const now = new Date().toISOString();
      const info = insertStmt.run(text, kind, source, now, now);
      return get(Number(info.lastInsertRowid));
    },
    update(id, patch) {
      const current = get(id);
      if (!current) return null;
      const text = patch.text !== undefined ? patch.text : current.text;
      const processed = patch.processed !== undefined ? patch.processed : current.processed;
      updateStmt.run(text, processed ? 1 : 0, new Date().toISOString(), id);
      return get(id);
    },
    remove(id) {
      if (!id) return false;
      return Number(deleteStmt.run(id).changes) > 0;
    },
  };
}
