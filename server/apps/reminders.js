// Reminders. The iPhone shell reads pending reminders and schedules them as iOS notifications,
// so they pop up on time even with the app closed.
// Routes: GET /api/reminders[?pending=1], POST {title, due_at | in_minutes, arm_on_allow?},
// PATCH/DELETE /api/reminders/:id, GET /api/reminders/badge, POST /api/reminders/device {status, version}
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';
import { now, parseId, text } from './_lib.js';

const shape = (row) => row && { id: row.id, title: row.title, due_at: row.due_at, done: Boolean(row.done), waiting_for_allow: row.arm_seconds != null, created_at: row.created_at };

function when(body) {
  if (typeof body.in_minutes === 'number' && Number.isFinite(body.in_minutes) && body.in_minutes > 0 && body.in_minutes <= 525600) {
    return new Date(Date.now() + body.in_minutes * 60_000).toISOString();
  }
  const due = new Date(body.due_at);
  if (typeof body.due_at !== 'string' || Number.isNaN(due.getTime())) throw new HttpError(400, 'send due_at or in_minutes');
  return due.toISOString();
}

export default {
  id: 'reminders',
  migrations: [{
    id: 'reminders-1',
    sql: `
      CREATE TABLE IF NOT EXISTS reminders (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        title       TEXT NOT NULL,
        due_at      TEXT NOT NULL,
        done        INTEGER NOT NULL DEFAULT 0,
        arm_seconds REAL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders (done, due_at);
      CREATE TABLE IF NOT EXISTS reminder_device (
        id      INTEGER PRIMARY KEY CHECK (id = 1),
        status  TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '',
        seen_at TEXT NOT NULL
      );`,
  }],
  register(r, { db }) {
    const get = (id) => db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
    const device = () => db.prepare('SELECT status, version, seen_at FROM reminder_device WHERE id = 1').get() || null;

    r.get('/api/reminders', (req, res, { query }) => {
      const rows = query.pending
        ? db.prepare('SELECT * FROM reminders WHERE done = 0 ORDER BY due_at LIMIT 200').all()
        : db.prepare('SELECT * FROM reminders ORDER BY done, CASE done WHEN 0 THEN due_at END, due_at DESC LIMIT 300').all();
      return { reminders: rows.map(shape), device: device() };
    });

    r.get('/api/reminders/badge', () => ({
      count: db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE done = 0 AND due_at <= ?').get(now()).n,
    }));

    // The phone reports whether notifications are allowed. A reminder made with arm_on_allow
    // starts its countdown here, so it cannot fire before the permission prompt is answered.
    r.post('/api/reminders/device', async (req, res) => {
      const body = await readJsonBody(req);
      const status = text(body.status, 'status', { max: 30, required: true });
      db.prepare(`INSERT INTO reminder_device (id, status, version, seen_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, version = excluded.version, seen_at = excluded.seen_at`)
        .run(status, text(body.version, 'version', { max: 40 }), now());
      if (status === 'authorized') {
        for (const row of db.prepare('SELECT id, arm_seconds FROM reminders WHERE arm_seconds IS NOT NULL').all()) {
          db.prepare('UPDATE reminders SET due_at = ?, arm_seconds = NULL, updated_at = ? WHERE id = ?')
            .run(new Date(Date.now() + row.arm_seconds * 1000).toISOString(), now(), row.id);
        }
      }
      return { ok: true };
    });

    r.post('/api/reminders', async (req, res) => {
      const body = await readJsonBody(req);
      const title = text(body.title, 'title', { max: 200, required: true });
      const due = when(body);
      const stamp = now();
      const arm = body.arm_on_allow === true ? Math.max(1, (new Date(due).getTime() - Date.now()) / 1000) : null;
      const made = db.prepare('INSERT INTO reminders (title, due_at, arm_seconds, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(title, due, arm, stamp, stamp);
      sendJson(res, 201, { reminder: shape(get(Number(made.lastInsertRowid))) });
    });

    r.patch('/api/reminders/:id', async (req, res, { params }) => {
      const id = parseId(params.id);
      const row = get(id);
      if (!row) throw new HttpError(404, 'reminder not found');
      const body = await readJsonBody(req);
      if (body.done !== undefined && typeof body.done !== 'boolean') throw new HttpError(400, 'done must be a boolean');
      const title = body.title === undefined ? row.title : text(body.title, 'title', { max: 200, required: true });
      const due = body.due_at === undefined && body.in_minutes === undefined ? row.due_at : when(body);
      db.prepare('UPDATE reminders SET title = ?, due_at = ?, done = ?, updated_at = ? WHERE id = ?')
        .run(title, due, body.done === undefined ? row.done : (body.done ? 1 : 0), now(), id);
      return { reminder: shape(get(id)) };
    });

    r.delete('/api/reminders/:id', (req, res, { params }) => {
      if (!db.prepare('DELETE FROM reminders WHERE id = ?').run(parseId(params.id)).changes) throw new HttpError(404, 'reminder not found');
      sendEmpty(res, 204);
    });
  },
};
