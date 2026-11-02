// Habits: daily habits, one check per habit per day, and a streak. Routes:
//   GET    /api/habits                      -> { habits: [...], days, today, dates }  active first, newest first
//   POST   /api/habits {name, color?}       -> 201 { habit }
//   GET    /api/habits/:id                  -> { habit }
//   PATCH  /api/habits/:id {name?, color?, archived?} -> { habit }
//   DELETE /api/habits/:id                  -> 204 (its checks go too)
//   PUT    /api/habits/:id/checks/:date     -> { habit }  check the day (idempotent)
//   DELETE /api/habits/:id/checks/:date     -> { habit }  uncheck the day (idempotent)
//
// Every { habit } is { id, name, color, archived, created_at, checks, streak }: `checks` are
// the checked dates inside the window (ascending, 'YYYY-MM-DD'), `streak` the number of
// consecutive checked days ending today or yesterday (a streak is not broken until a day is
// actually missed). The window comes from the query on every route: `days` (1..90, default
// 7) and `today` (the phone's local date, 'YYYY-MM-DD'; default the server's local date).
// The phone sends its own `today` so day keys always mean the phone's local days.
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';

const NAME_MAX = 100;
const DAYS_DEFAULT = 7;
const DAYS_MAX = 90;
const DEFAULT_COLOR = '#ff9f0a';
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// C0 controls plus DEL never belong in a name (a NUL would truncate it on read).
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
// Zero-width characters that make a name look empty (U+200D stays: emoji sequences need it).
const INVISIBLE = /[​‌⁠﻿]/g;

export default {
  id: 'habits',
  migrations: [
    {
      id: 'habits-1',
      sql: `
        CREATE TABLE IF NOT EXISTS habits (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT    NOT NULL,
          color      TEXT    NOT NULL,
          created_at TEXT    NOT NULL,
          archived   INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS habit_checks (
          habit_id   INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
          date       TEXT    NOT NULL,
          PRIMARY KEY (habit_id, date)
        );
        CREATE INDEX IF NOT EXISTS habit_checks_date ON habit_checks (date);
      `,
    },
  ],
  register(r, ctx) {
    const repo = habitsRepo(ctx.db);

    r.get('/api/habits', (req, res, { query }) => {
      const win = windowFrom(query);
      return { habits: repo.list().map((h) => repo.enrich(h, win)), days: win.days, today: win.today, dates: win.dates };
    });

    r.post('/api/habits', async (req, res, { query }) => {
      const win = windowFrom(query);
      const body = await readJsonBody(req);
      const name = validateName(body.name);
      const color = body.color === undefined ? DEFAULT_COLOR : validateColor(body.color);
      sendJson(res, 201, { habit: repo.enrich(repo.create(name, color), win) });
    });

    r.get('/api/habits/:id', (req, res, { params, query }) => {
      const win = windowFrom(query);
      const habit = repo.get(parseId(params.id));
      if (!habit) throw new HttpError(404, 'habit not found');
      return { habit: repo.enrich(habit, win) };
    });

    r.patch('/api/habits/:id', async (req, res, { params, query }) => {
      const win = windowFrom(query);
      const id = parseId(params.id);
      if (!repo.get(id)) throw new HttpError(404, 'habit not found');
      const body = await readJsonBody(req);
      const patch = {};
      if (body.name !== undefined) patch.name = validateName(body.name);
      if (body.color !== undefined) patch.color = validateColor(body.color);
      if (body.archived !== undefined) {
        if (typeof body.archived !== 'boolean') throw new HttpError(400, 'archived must be a boolean');
        patch.archived = body.archived;
      }
      if (!Object.keys(patch).length) throw new HttpError(400, 'nothing to update: send name, color and/or archived');
      const habit = repo.update(id, patch);
      if (!habit) throw new HttpError(404, 'habit not found');
      return { habit: repo.enrich(habit, win) };
    });

    r.delete('/api/habits/:id', (req, res, { params }) => {
      if (!repo.remove(parseId(params.id))) throw new HttpError(404, 'habit not found');
      sendEmpty(res, 204);
    });

    r.put('/api/habits/:id/checks/:date', (req, res, { params, query }) => {
      const win = windowFrom(query);
      const habit = repo.get(parseId(params.id));
      if (!habit) throw new HttpError(404, 'habit not found');
      const date = validateCheckDate(params.date, win.today);
      repo.check(habit.id, date, true);
      return { habit: repo.enrich(habit, win) };
    });

    r.delete('/api/habits/:id/checks/:date', (req, res, { params, query }) => {
      const win = windowFrom(query);
      const habit = repo.get(parseId(params.id));
      if (!habit) throw new HttpError(404, 'habit not found');
      const date = validateCheckDate(params.date, win.today);
      repo.check(habit.id, date, false);
      return { habit: repo.enrich(habit, win) };
    });
  },
};

// ---------------------------------------------------------------- validation

function parseId(raw) {
  if (!/^\d{1,15}$/.test(String(raw))) return 0;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function validateName(name) {
  if (typeof name !== 'string') throw new HttpError(400, 'name must be a string');
  const trimmed = name.trim();
  if (!trimmed || !trimmed.replace(INVISIBLE, '').trim()) throw new HttpError(400, 'name is required');
  if (trimmed.length > NAME_MAX) throw new HttpError(400, `name is too long (max ${NAME_MAX} characters)`);
  if (CONTROL_CHARS.test(trimmed)) throw new HttpError(400, 'name contains control characters');
  return trimmed;
}

function validateColor(color) {
  if (typeof color !== 'string' || !COLOR_RE.test(color.trim())) throw new HttpError(400, 'color must be a #rrggbb hex colour');
  return color.trim().toLowerCase();
}

// The window every reply is computed for: { days, today, dates (ascending, today last) }.
function windowFrom(query = {}) {
  let days = DAYS_DEFAULT;
  if (query.days !== undefined) {
    if (!/^\d{1,3}$/.test(String(query.days))) throw new HttpError(400, 'days must be a whole number');
    days = Number(query.days);
    if (days < 1 || days > DAYS_MAX) throw new HttpError(400, `days must be between 1 and ${DAYS_MAX}`);
  }
  let today = localToday();
  if (query.today !== undefined) {
    today = parseDay(query.today);
    if (!today) throw new HttpError(400, 'today must be a valid YYYY-MM-DD date');
  }
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(addDays(today, -i));
  return { days, today, dates };
}

function validateCheckDate(raw, today) {
  const date = parseDay(raw);
  if (!date) throw new HttpError(400, 'date must be a valid YYYY-MM-DD date');
  if (date > today) throw new HttpError(400, 'date is in the future');
  return date;
}

// ---------------------------------------------------------------- day keys ('YYYY-MM-DD')

const two = (n) => String(n).padStart(2, '0');

// Validates a calendar date (2000..2100) and returns it normalised, or null.
function parseDay(raw) {
  const m = DATE_RE.exec(String(raw));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return keyOf(dt);
}

function keyOf(dt) {
  return `${dt.getUTCFullYear()}-${two(dt.getUTCMonth() + 1)}-${two(dt.getUTCDate())}`;
}

// Day arithmetic in UTC: a day key is a calendar day, not an instant, so DST never shifts it.
function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return keyOf(new Date(Date.UTC(y, m - 1, d + n)));
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

// Consecutive checked days ending today, or ending yesterday when today is not (yet) checked.
export function streakOf(checked, today) {
  const set = checked instanceof Set ? checked : new Set(checked);
  let cursor = set.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (set.has(cursor)) {
    n += 1;
    cursor = addDays(cursor, -1);
  }
  return n;
}

// ---------------------------------------------------------------- repo

function rowToHabit(row) {
  return {
    id: Number(row.id),
    name: row.name,
    color: row.color,
    archived: Boolean(row.archived),
    created_at: row.created_at,
  };
}

function habitsRepo(db) {
  const listStmt = db.prepare('SELECT * FROM habits ORDER BY archived ASC, created_at DESC, id DESC');
  const getStmt = db.prepare('SELECT * FROM habits WHERE id = ?');
  const insertStmt = db.prepare('INSERT INTO habits (name, color, created_at, archived) VALUES (?, ?, ?, 0)');
  const updateStmt = db.prepare('UPDATE habits SET name = ?, color = ?, archived = ? WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM habits WHERE id = ?');
  const deleteChecksStmt = db.prepare('DELETE FROM habit_checks WHERE habit_id = ?');
  const checksStmt = db.prepare('SELECT date FROM habit_checks WHERE habit_id = ? ORDER BY date DESC');
  const checkOnStmt = db.prepare('INSERT OR IGNORE INTO habit_checks (habit_id, date) VALUES (?, ?)');
  const checkOffStmt = db.prepare('DELETE FROM habit_checks WHERE habit_id = ? AND date = ?');

  const get = (id) => {
    if (!id) return null;
    const row = getStmt.get(id);
    return row ? rowToHabit(row) : null;
  };

  return {
    list: () => listStmt.all().map(rowToHabit),
    get,
    create(name, color) {
      const info = insertStmt.run(name, color, new Date().toISOString());
      return get(Number(info.lastInsertRowid));
    },
    update(id, patch) {
      const current = get(id);
      if (!current) return null;
      const name = patch.name !== undefined ? patch.name : current.name;
      const color = patch.color !== undefined ? patch.color : current.color;
      const archived = patch.archived !== undefined ? patch.archived : current.archived;
      updateStmt.run(name, color, archived ? 1 : 0, id);
      return get(id);
    },
    // The FK cascades, but the checks are deleted explicitly too in case foreign_keys is
    // ever off on a connection: a habit must never leave orphan checks behind.
    remove(id) {
      if (!id) return false;
      db.exec('BEGIN');
      try {
        deleteChecksStmt.run(id);
        const info = deleteStmt.run(id);
        db.exec('COMMIT');
        return Number(info.changes) > 0;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    check(id, date, on) {
      if (on) checkOnStmt.run(id, date);
      else checkOffStmt.run(id, date);
    },
    // Adds `checks` (inside the window, ascending) and `streak` to a habit.
    enrich(habit, { days, today }) {
      const all = checksStmt.all(habit.id).map((row) => String(row.date));
      const start = addDays(today, -(days - 1));
      const checks = all.filter((d) => d >= start && d <= today).sort();
      return { ...habit, checks, streak: streakOf(all, today) };
    },
  };
}
