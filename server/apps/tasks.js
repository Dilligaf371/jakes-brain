// Tasks: the v1 checklist. The table is the renamed v1 `notes` table (core-2), shape
// (id, text, done, created_at, updated_at). Routes:
//   GET    /api/tasks          -> { tasks: [...] }   open first (newest first), then done
//   POST   /api/tasks {text}   -> 201 { task }
//   PATCH  /api/tasks/:id {text?, done?} -> { task }
//   DELETE /api/tasks/:id      -> 204
//   GET    /api/tasks/badge    -> { count: <open> }
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';

const TEXT_MAX = 2000;
// C0 controls other than \t \n \r, plus DEL. node:sqlite hands text back as a C string, so
// a NUL would silently truncate the task on read; the rest never belong in one.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// Zero-width characters that make a task look empty. Only used for the emptiness check:
// U+200D stays in stored text because emoji ZWJ sequences need it.
const INVISIBLE = /[​‌‍⁠﻿]/g;

export default {
  id: 'tasks',
  migrations: [
    {
      // core-2 already renamed the v1 table; this only guarantees the table + index exist
      // on a database that never had v1 data.
      id: 'tasks-1',
      sql: `
        CREATE TABLE IF NOT EXISTS tasks (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          text       TEXT    NOT NULL,
          done       INTEGER NOT NULL DEFAULT 0,
          created_at TEXT    NOT NULL,
          updated_at TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS tasks_done_created ON tasks (done, created_at DESC);
      `,
    },
  ],
  register(r, ctx) {
    const repo = tasksRepo(ctx.db);

    r.get('/api/tasks', () => ({ tasks: repo.list() }));

    r.get('/api/tasks/badge', () => ({ count: repo.openCount() }));

    r.post('/api/tasks', async (req, res) => {
      const body = await readJsonBody(req);
      const text = validateText(body.text);
      sendJson(res, 201, { task: repo.create(text) });
    });

    r.get('/api/tasks/:id', (req, res, { params }) => {
      const task = repo.get(parseId(params.id));
      if (!task) throw new HttpError(404, 'task not found');
      return { task };
    });

    r.patch('/api/tasks/:id', async (req, res, { params }) => {
      // Resolve the task first so a missing id is a 404 whatever the body says.
      const id = parseId(params.id);
      if (!repo.get(id)) throw new HttpError(404, 'task not found');
      const body = await readJsonBody(req);
      const patch = {};
      if (body.text !== undefined) patch.text = validateText(body.text);
      if (body.done !== undefined) {
        if (typeof body.done !== 'boolean') throw new HttpError(400, 'done must be a boolean');
        patch.done = body.done;
      }
      if (patch.text === undefined && patch.done === undefined) {
        throw new HttpError(400, 'nothing to update: send text and/or done');
      }
      const task = repo.update(id, patch);
      if (!task) throw new HttpError(404, 'task not found');
      return { task };
    });

    r.delete('/api/tasks/:id', (req, res, { params }) => {
      if (!repo.remove(parseId(params.id))) throw new HttpError(404, 'task not found');
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

function rowToTask(row) {
  return {
    id: Number(row.id),
    text: row.text,
    done: Boolean(row.done),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function tasksRepo(db) {
  const listStmt = db.prepare('SELECT * FROM tasks ORDER BY done ASC, created_at DESC, id DESC');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE done = 0');
  const getStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const insertStmt = db.prepare('INSERT INTO tasks (text, done, created_at, updated_at) VALUES (?, 0, ?, ?)');
  const updateStmt = db.prepare('UPDATE tasks SET text = ?, done = ?, updated_at = ? WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM tasks WHERE id = ?');

  const get = (id) => {
    if (!id) return null;
    const row = getStmt.get(id);
    return row ? rowToTask(row) : null;
  };

  return {
    list: () => listStmt.all().map(rowToTask),
    openCount: () => Number(countStmt.get().n),
    get,
    create(text) {
      const now = new Date().toISOString();
      const info = insertStmt.run(text, now, now);
      return get(Number(info.lastInsertRowid));
    },
    update(id, patch) {
      const current = get(id);
      if (!current) return null;
      const text = patch.text !== undefined ? patch.text : current.text;
      const done = patch.done !== undefined ? patch.done : current.done;
      updateStmt.run(text, done ? 1 : 0, new Date().toISOString(), id);
      return get(id);
    },
    remove(id) {
      if (!id) return false;
      const info = deleteStmt.run(id);
      return Number(info.changes) > 0;
    },
  };
}
