// Notes: real notes with a title + body, pin, server-side search. Table `notes`
// (id, title, body, pinned, created_at, updated_at); migration notes-1 runs after core-2 has
// renamed the v1 checklist to `tasks`, so the name is free. Routes:
//   GET    /api/notes?q=        -> { notes: [{ id, title, preview, pinned, created_at, updated_at }] }
//                                  pinned first, then updated_at desc; q = every whitespace-separated
//                                  term must match title or body (LIKE, case-insensitive for ASCII)
//   POST   /api/notes {title?, body?}          -> 201 { note }
//   GET    /api/notes/:id                      -> { note }   (full body)
//   PATCH  /api/notes/:id {title?, body?, pinned?} -> { note }
//   DELETE /api/notes/:id                      -> 204
// Note shape: { id, title, body, pinned (boolean), created_at, updated_at }. A pin/unpin does
// NOT bump updated_at (it is not an edit, and the list is ordered by it).
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';

const TITLE_MAX = 500;
const BODY_MAX = 200_000;          // characters; the JSON body cap below leaves room for escapes
const JSON_LIMIT = 1024 * 1024;    // the core default is 64 KB, too small for a long note
const QUERY_MAX = 200;
const QUERY_TERMS_MAX = 8;
const PREVIEW_MAX = 140;
// C0 controls other than \t \n \r, plus DEL. node:sqlite hands text back as a C string, so a
// NUL would silently truncate the note on read. Autosave must never refuse a keystroke, so
// these are stripped rather than rejected (a note never legitimately contains them).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export default {
  id: 'notes',
  migrations: [
    {
      id: 'notes-1',
      sql: `
        CREATE TABLE IF NOT EXISTS notes (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          title      TEXT    NOT NULL DEFAULT '',
          body       TEXT    NOT NULL DEFAULT '',
          pinned     INTEGER NOT NULL DEFAULT 0,
          created_at TEXT    NOT NULL,
          updated_at TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS notes_pinned_updated ON notes (pinned DESC, updated_at DESC);
      `,
    },
  ],
  register(r, ctx) {
    const repo = notesRepo(ctx.db);

    r.get('/api/notes', (req, res, { query }) => ({ notes: repo.list(parseQuery(query.q)) }));

    r.post('/api/notes', async (req, res) => {
      const body = await readJsonBody(req, { limit: JSON_LIMIT });
      const title = body.title === undefined ? '' : validateText('title', body.title, TITLE_MAX);
      const text = body.body === undefined ? '' : validateText('body', body.body, BODY_MAX);
      sendJson(res, 201, { note: repo.create(title, text) });
    });

    r.get('/api/notes/:id', (req, res, { params }) => {
      const note = repo.get(parseId(params.id));
      if (!note) throw new HttpError(404, 'note not found');
      return { note };
    });

    r.patch('/api/notes/:id', async (req, res, { params }) => {
      // Resolve the note first so a missing id is a 404 whatever the body says.
      const id = parseId(params.id);
      if (!repo.get(id)) throw new HttpError(404, 'note not found');
      const body = await readJsonBody(req, { limit: JSON_LIMIT });
      const patch = {};
      if (body.title !== undefined) patch.title = validateText('title', body.title, TITLE_MAX);
      if (body.body !== undefined) patch.body = validateText('body', body.body, BODY_MAX);
      if (body.pinned !== undefined) {
        if (typeof body.pinned !== 'boolean') throw new HttpError(400, 'pinned must be a boolean');
        patch.pinned = body.pinned;
      }
      if (!Object.keys(patch).length) throw new HttpError(400, 'nothing to update: send title, body and/or pinned');
      const note = repo.update(id, patch);
      if (!note) throw new HttpError(404, 'note not found');
      return { note };
    });

    r.delete('/api/notes/:id', (req, res, { params }) => {
      if (!repo.remove(parseId(params.id))) throw new HttpError(404, 'note not found');
      sendEmpty(res, 204);
    });
  },
};

// A malformed id is a 400 (bad input); a well-formed id with no row is the handler's 404.
function parseId(raw) {
  const s = String(raw);
  if (!/^\d{1,15}$/.test(s)) throw new HttpError(400, 'bad note id');
  const id = Number(s);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'bad note id');
  return id;
}

// Title: one line, trimmed. Body: kept as typed (leading/trailing whitespace included, so a
// note that starts with a blank line stays that way), newlines normalised to \n.
function validateText(field, value, max) {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  let text = value.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
  if (field === 'title') text = text.replace(/\n/g, ' ').trim();
  if (text.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return text;
}

// ?q= -> up to 8 non-empty terms (or null when there is nothing to search for).
function parseQuery(raw) {
  if (raw === undefined || raw === null) return null;
  const q = String(raw);
  if (q.length > QUERY_MAX) throw new HttpError(400, `q is too long (max ${QUERY_MAX} characters)`);
  const terms = q.replace(CONTROL_CHARS, '').split(/\s+/).filter(Boolean).slice(0, QUERY_TERMS_MAX);
  return terms.length ? terms : null;
}

function likePattern(term) {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// First non-empty line of the body, trimmed, capped. Computed from a prefix of the body so a
// 200 KB note does not have to be shipped (or scanned) for its list row.
function preview(bodyHead) {
  const text = String(bodyHead || '');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX - 1)}…` : t;
  }
  return '';
}

function rowToNote(row) {
  return {
    id: Number(row.id),
    title: row.title,
    body: row.body,
    pinned: Boolean(row.pinned),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToListItem(row) {
  return {
    id: Number(row.id),
    title: row.title,
    preview: preview(row.body_head),
    pinned: Boolean(row.pinned),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function notesRepo(db) {
  const LIST_COLS = 'id, title, substr(body, 1, 600) AS body_head, pinned, created_at, updated_at';
  const ORDER = 'ORDER BY pinned DESC, updated_at DESC, id DESC';
  const listStmt = db.prepare(`SELECT ${LIST_COLS} FROM notes ${ORDER}`);
  const searchStmts = new Map(); // term count -> prepared statement
  const getStmt = db.prepare('SELECT * FROM notes WHERE id = ?');
  const insertStmt = db.prepare('INSERT INTO notes (title, body, pinned, created_at, updated_at) VALUES (?, ?, 0, ?, ?)');
  const updateStmt = db.prepare('UPDATE notes SET title = ?, body = ?, pinned = ?, updated_at = ? WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM notes WHERE id = ?');

  function searchStmt(count) {
    if (!searchStmts.has(count)) {
      const clause = Array.from({ length: count }, () => "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')").join(' AND ');
      searchStmts.set(count, db.prepare(`SELECT ${LIST_COLS} FROM notes WHERE ${clause} ${ORDER}`));
    }
    return searchStmts.get(count);
  }

  const get = (id) => {
    if (!id) return null;
    const row = getStmt.get(id);
    return row ? rowToNote(row) : null;
  };

  return {
    list(terms) {
      if (!terms) return listStmt.all().map(rowToListItem);
      const args = terms.flatMap((t) => {
        const p = likePattern(t);
        return [p, p];
      });
      return searchStmt(terms.length).all(...args).map(rowToListItem);
    },
    get,
    create(title, body) {
      const now = new Date().toISOString();
      const info = insertStmt.run(title, body, now, now);
      return get(Number(info.lastInsertRowid));
    },
    update(id, patch) {
      const current = get(id);
      if (!current) return null;
      const title = patch.title !== undefined ? patch.title : current.title;
      const body = patch.body !== undefined ? patch.body : current.body;
      const pinned = patch.pinned !== undefined ? patch.pinned : current.pinned;
      const edited = title !== current.title || body !== current.body;
      updateStmt.run(title, body, pinned ? 1 : 0, edited ? new Date().toISOString() : current.updated_at, id);
      return get(id);
    },
    remove(id) {
      if (!id) return false;
      const info = deleteStmt.run(id);
      return Number(info.changes) > 0;
    },
  };
}
