// Focus: logged focus sessions. The timer itself runs in the page.
// Routes: GET /api/focus?days=7, POST /api/focus {label, minutes, started_at}, DELETE /api/focus/:id
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';
import { now, parseId, text, localDay } from './_lib.js';

export default {
  id: 'focus',
  migrations: [{
    id: 'focus-1',
    sql: `
      CREATE TABLE IF NOT EXISTS focus_sessions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        label      TEXT NOT NULL DEFAULT '',
        minutes    REAL NOT NULL,
        started_at TEXT NOT NULL,
        ended_at   TEXT NOT NULL
      );`,
  }],
  register(r, { db }) {
    r.get('/api/focus', (req, res, { query }) => {
      const days = Math.min(Math.max(Number(query.days) || 7, 1), 60);
      const span = [];
      for (let i = days - 1; i >= 0; i -= 1) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        span.push(localDay(d));
      }
      const start = new Date(`${span[0]}T00:00:00`).toISOString();
      const sessions = db.prepare('SELECT * FROM focus_sessions WHERE started_at >= ? ORDER BY started_at DESC').all(start);
      const totals = new Map(span.map((date) => [date, 0]));
      for (const s of sessions) {
        const key = localDay(s.started_at);
        if (totals.has(key)) totals.set(key, totals.get(key) + s.minutes);
      }
      const byDay = [...totals].map(([date, minutes]) => ({ date, minutes }));
      return { sessions, byDay, total: byDay.reduce((sum, d) => sum + d.minutes, 0), today: byDay.at(-1).minutes };
    });

    r.post('/api/focus', async (req, res) => {
      const body = await readJsonBody(req);
      const minutes = body.minutes;
      if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || minutes > 720) {
        throw new HttpError(400, 'minutes must be between 0 and 720');
      }
      const started = new Date(body.started_at);
      if (Number.isNaN(started.getTime())) throw new HttpError(400, 'started_at must be a date');
      const made = db.prepare('INSERT INTO focus_sessions (label, minutes, started_at, ended_at) VALUES (?, ?, ?, ?)')
        .run(text(body.label, 'label', { max: 120 }), minutes, started.toISOString(), now());
      sendJson(res, 201, { session: db.prepare('SELECT * FROM focus_sessions WHERE id = ?').get(Number(made.lastInsertRowid)) });
    });

    r.delete('/api/focus/:id', (req, res, { params }) => {
      if (!db.prepare('DELETE FROM focus_sessions WHERE id = ?').run(parseId(params.id)).changes) throw new HttpError(404, 'session not found');
      sendEmpty(res, 204);
    });
  },
};
