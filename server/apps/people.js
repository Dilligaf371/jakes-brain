// People: a simple contact list. Each person has an @handle; the Graph links any text that
// mentions it. Routes: GET/POST /api/people, GET/PATCH/DELETE /api/people/:id
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';
import { now, parseId, text } from './_lib.js';

const HANDLE = /^[a-z0-9_.-]{1,40}$/;
const slug = (name) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '').slice(0, 36) || 'person';

export default {
  id: 'people',
  migrations: [{
    id: 'people-1',
    sql: `
      CREATE TABLE IF NOT EXISTS people (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        handle     TEXT NOT NULL UNIQUE,
        role       TEXT NOT NULL DEFAULT '',
        contact    TEXT NOT NULL DEFAULT '',
        notes      TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
  }],
  register(r, { db }) {
    const get = (id) => db.prepare('SELECT * FROM people WHERE id = ?').get(id);
    const taken = (handle, id = 0) => db.prepare('SELECT 1 FROM people WHERE handle = ? AND id != ?').get(handle, id);

    function freeHandle(name) {
      const base = slug(name);
      let handle = base;
      for (let n = 2; taken(handle); n += 1) handle = `${base}${n}`;
      return handle;
    }
    function checkHandle(raw, id) {
      const handle = text(raw, 'handle', { max: 40 }).replace(/^@/, '').toLowerCase();
      if (!HANDLE.test(handle)) throw new HttpError(400, 'handle can use letters, numbers, . _ and -');
      if (taken(handle, id)) throw new HttpError(409, `@${handle} is already taken`);
      return handle;
    }

    r.get('/api/people', (req, res, { query }) => {
      const q = text(query.q, 'q', { max: 100 });
      if (!q) return { people: db.prepare('SELECT * FROM people ORDER BY name COLLATE NOCASE').all() };
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      return { people: db.prepare(`SELECT * FROM people WHERE name LIKE ?1 ESCAPE '\\' OR handle LIKE ?1 ESCAPE '\\' OR role LIKE ?1 ESCAPE '\\' OR notes LIKE ?1 ESCAPE '\\' ORDER BY name COLLATE NOCASE`).all(like) };
    });

    r.post('/api/people', async (req, res) => {
      const body = await readJsonBody(req);
      const name = text(body.name, 'name', { max: 120, required: true });
      const handle = body.handle ? checkHandle(body.handle, 0) : freeHandle(name);
      const stamp = now();
      const made = db.prepare('INSERT INTO people (name, handle, role, contact, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(name, handle, text(body.role, 'role', { max: 200 }), text(body.contact, 'contact', { max: 400 }), text(body.notes, 'notes', { max: 8000 }), stamp, stamp);
      sendJson(res, 201, { person: get(Number(made.lastInsertRowid)) });
    });

    r.get('/api/people/:id', (req, res, { params }) => {
      const person = get(parseId(params.id));
      if (!person) throw new HttpError(404, 'person not found');
      return { person };
    });

    r.patch('/api/people/:id', async (req, res, { params }) => {
      const id = parseId(params.id);
      const current = get(id);
      if (!current) throw new HttpError(404, 'person not found');
      const body = { ...current, ...(await readJsonBody(req)) };
      db.prepare('UPDATE people SET name = ?, handle = ?, role = ?, contact = ?, notes = ?, updated_at = ? WHERE id = ?').run(
        text(body.name, 'name', { max: 120, required: true }), checkHandle(body.handle, id),
        text(body.role, 'role', { max: 200 }), text(body.contact, 'contact', { max: 400 }), text(body.notes, 'notes', { max: 8000 }), now(), id);
      return { person: get(id) };
    });

    r.delete('/api/people/:id', (req, res, { params }) => {
      if (!db.prepare('DELETE FROM people WHERE id = ?').run(parseId(params.id)).changes) throw new HttpError(404, 'person not found');
      sendEmpty(res, 204);
    });
  },
};
