// Calendar: events on a day, optionally timed. Table calendar_events (migration calendar-1).
// Routes (all JSON, errors as { error }):
//   GET    /api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD   -> { events: [...] }  inclusive, max 62 days
//   POST   /api/calendar/events {title, date, all_day?, start_time?, end_time?, notes?} -> 201 { event }
//   GET    /api/calendar/events/:id                              -> { event }
//   PATCH  /api/calendar/events/:id {title?, date?, all_day?, start_time?, end_time?, notes?} -> { event }
//   DELETE /api/calendar/events/:id                              -> 204
//
// Event shape: { id, title, date 'YYYY-MM-DD', start_time 'HH:MM'|null, end_time 'HH:MM'|null,
// all_day boolean, notes, created_at, updated_at }. An all-day event has both times null; a
// timed event always has a start_time (end_time optional, never before the start). A POST
// with neither all_day nor start_time is an all-day event. Day keys are plain strings:
// no Date objects touch them, so the server's time zone never shifts a day.
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';

const TITLE_MAX = 200;
const NOTES_MAX = 4000;
const RANGE_MAX_DAYS = 62;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;
// C0 controls (except \t \n \r, allowed in notes) and DEL: node:sqlite reads text back as a
// C string, so a NUL would truncate the row on read; none of the others belong in text.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const TITLE_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const DAY_MS = 86_400_000;

export default {
  id: 'calendar',
  migrations: [
    {
      id: 'calendar-1',
      sql: `
        CREATE TABLE IF NOT EXISTS calendar_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          title      TEXT    NOT NULL,
          date       TEXT    NOT NULL,
          start_time TEXT,
          end_time   TEXT,
          all_day    INTEGER NOT NULL DEFAULT 0,
          notes      TEXT    NOT NULL DEFAULT '',
          created_at TEXT    NOT NULL,
          updated_at TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS calendar_events_date ON calendar_events (date, all_day DESC, start_time);
      `,
    },
  ],
  register(r, ctx) {
    const repo = eventsRepo(ctx.db);

    r.get('/api/calendar/events', (req, res, { query }) => {
      const from = parseDate(query.from, 'from');
      const to = parseDate(query.to, 'to');
      if (to < from) throw new HttpError(400, 'to must not be before from');
      if (daysBetween(from, to) + 1 > RANGE_MAX_DAYS) throw new HttpError(400, `range is too long (max ${RANGE_MAX_DAYS} days)`);
      return { from, to, events: repo.list(from, to) };
    });

    r.post('/api/calendar/events', async (req, res) => {
      const body = await readJsonBody(req);
      const fields = validateEvent(body, null);
      sendJson(res, 201, { event: repo.create(fields) });
    });

    r.get('/api/calendar/events/:id', (req, res, { params }) => {
      const event = repo.get(parseId(params.id));
      if (!event) throw new HttpError(404, 'event not found');
      return { event };
    });

    r.patch('/api/calendar/events/:id', async (req, res, { params }) => {
      // Resolve the event first so a missing id is a 404 whatever the body says.
      const id = parseId(params.id);
      const current = repo.get(id);
      if (!current) throw new HttpError(404, 'event not found');
      const body = await readJsonBody(req);
      const known = ['title', 'date', 'all_day', 'start_time', 'end_time', 'notes'];
      if (!known.some((key) => body[key] !== undefined)) {
        throw new HttpError(400, `nothing to update: send one of ${known.join(', ')}`);
      }
      const fields = validateEvent(body, current);
      const event = repo.update(id, fields);
      if (!event) throw new HttpError(404, 'event not found');
      return { event };
    });

    r.delete('/api/calendar/events/:id', (req, res, { params }) => {
      if (!repo.remove(parseId(params.id))) throw new HttpError(404, 'event not found');
      sendEmpty(res, 204);
    });
  },
};

// ---------------------------------------------------------------- validation

function parseId(raw) {
  if (!/^\d{1,15}$/.test(String(raw))) return 0;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

// 'YYYY-MM-DD' that is a real calendar day (2026-02-30 is rejected). Pure arithmetic via
// Date.UTC: the server's local time zone plays no part.
function parseDate(value, field) {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a date like 2026-11-02`);
  const m = DATE_RE.exec(value);
  if (!m) throw new HttpError(400, `${field} must be a date like 2026-11-02`);
  const [, y, mo, d] = m.map(Number);
  if (y < 1900 || y > 2999 || mo < 1 || mo > 12 || d < 1 || d > 31) throw new HttpError(400, `${field} is not a valid date`);
  const utc = new Date(Date.UTC(y, mo - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) {
    throw new HttpError(400, `${field} is not a valid date`);
  }
  return value;
}

function daysBetween(fromKey, toKey) {
  const toUtc = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(toKey) - toUtc(fromKey)) / DAY_MS);
}

// 'HH:MM' (24 h) or null. Returns the normalised string or null.
function parseTime(value, field) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a time like 09:30`);
  const m = TIME_RE.exec(value.trim());
  if (!m) throw new HttpError(400, `${field} must be a time like 09:30`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new HttpError(400, `${field} is not a valid time`);
  return `${m[1]}:${m[2]}`;
}

function parseTitle(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'title must be a string');
  const title = value.trim();
  if (!title) throw new HttpError(400, 'title is required');
  if (title.length > TITLE_MAX) throw new HttpError(400, `title is too long (max ${TITLE_MAX} characters)`);
  if (TITLE_CONTROL_CHARS.test(title)) throw new HttpError(400, 'title contains control characters');
  return title;
}

function parseNotes(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'notes must be a string');
  const notes = value.replace(/\r\n?/g, '\n').trim();
  if (notes.length > NOTES_MAX) throw new HttpError(400, `notes are too long (max ${NOTES_MAX} characters)`);
  if (CONTROL_CHARS.test(notes)) throw new HttpError(400, 'notes contain control characters');
  return notes;
}

// Validates a POST body (current = null: title + date required) or a PATCH body merged over
// the current event. Returns the full set of stored fields.
function validateEvent(body, current) {
  const out = {};
  if (body.title !== undefined || !current) out.title = parseTitle(body.title);
  else out.title = current.title;

  if (body.date !== undefined || !current) out.date = parseDate(body.date, 'date');
  else out.date = current.date;

  if (body.notes !== undefined) out.notes = parseNotes(body.notes);
  else out.notes = current ? current.notes : '';

  let start = body.start_time !== undefined ? parseTime(body.start_time, 'start_time') : (current ? current.start_time : null);
  let end = body.end_time !== undefined ? parseTime(body.end_time, 'end_time') : (current ? current.end_time : null);

  let allDay;
  if (body.all_day !== undefined) {
    if (typeof body.all_day !== 'boolean') throw new HttpError(400, 'all_day must be a boolean');
    allDay = body.all_day;
  } else if (body.start_time !== undefined && body.start_time !== null && body.start_time !== '') {
    allDay = false; // a time was sent: the event is timed now
  } else if (current) {
    allDay = current.all_day;
  } else {
    allDay = start === null; // POST with no times and no all_day: an all-day event
  }

  if (allDay) {
    start = null;
    end = null;
  } else {
    if (start === null) throw new HttpError(400, 'start_time is required unless all_day is true');
    if (end !== null && end < start) throw new HttpError(400, 'end_time must not be before start_time');
  }
  out.all_day = allDay;
  out.start_time = start;
  out.end_time = end;
  return out;
}

// ---------------------------------------------------------------- repo

function rowToEvent(row) {
  return {
    id: Number(row.id),
    title: row.title,
    date: row.date,
    start_time: row.start_time == null ? null : row.start_time,
    end_time: row.end_time == null ? null : row.end_time,
    all_day: Boolean(row.all_day),
    notes: row.notes == null ? '' : row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function eventsRepo(db) {
  const listStmt = db.prepare(`
    SELECT * FROM calendar_events
    WHERE date >= ? AND date <= ?
    ORDER BY date ASC, all_day DESC, start_time ASC, title COLLATE NOCASE ASC, id ASC
  `);
  const getStmt = db.prepare('SELECT * FROM calendar_events WHERE id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO calendar_events (title, date, start_time, end_time, all_day, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE calendar_events
    SET title = ?, date = ?, start_time = ?, end_time = ?, all_day = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `);
  const deleteStmt = db.prepare('DELETE FROM calendar_events WHERE id = ?');

  const get = (id) => {
    if (!id) return null;
    const row = getStmt.get(id);
    return row ? rowToEvent(row) : null;
  };

  return {
    list: (from, to) => listStmt.all(from, to).map(rowToEvent),
    get,
    create(f) {
      const now = new Date().toISOString();
      const info = insertStmt.run(f.title, f.date, f.start_time, f.end_time, f.all_day ? 1 : 0, f.notes, now, now);
      return get(Number(info.lastInsertRowid));
    },
    update(id, f) {
      if (!get(id)) return null;
      updateStmt.run(f.title, f.date, f.start_time, f.end_time, f.all_day ? 1 : 0, f.notes, new Date().toISOString(), id);
      return get(id);
    },
    remove(id) {
      if (!id) return false;
      const info = deleteStmt.run(id);
      return Number(info.changes) > 0;
    },
  };
}
