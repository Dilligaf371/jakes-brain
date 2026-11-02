// Food: a calorie and macro log (replaces the Notion "Macros & Calories Tracker").
// One row per thing eaten: date, meal, name, calories, protein / carbs / fat in grams, notes.
// Claude logs to it through the connector (server/apps/connector.js), the app reads and edits it.
// Routes:
//   GET    /api/food/day/:date            -> { date, entries, totals, goals }   date = YYYY-MM-DD or "today"
//   GET    /api/food/days?from=&to=       -> { days: [{ date, calories, protein, carbs, fat, count }] }
//          oldest first, only days with entries; default the last 30 days; max 400 days
//   POST   /api/food/entries {date?, meal, name, calories, protein?, carbs?, fat?, notes?, ext_id?}
//          -> 201 { entry }      date defaults to today (the PC's local date)
//   POST   /api/food/entries { entries: [ ... up to 500 ] }
//          -> 201 { entries, skipped }   an entry whose ext_id already exists is skipped (safe re-import)
//   PATCH  /api/food/entries/:id {any field above except ext_id} -> { entry }
//   DELETE /api/food/entries/:id          -> 204
//   GET    /api/food/recent               -> { foods: [{ name, meal, calories, protein, carbs, fat, times }] }
//          most-eaten foods of the last 60 days, for one-tap re-adding
//   GET    /api/food/search?q=            -> { entries }   past entries whose name matches, newest first (max 25)
//   GET    /api/food/goals                -> { goals: { calories, protein, carbs, fat } }   (null = not set)
//   PUT    /api/food/goals {calories?, protein?, carbs?, fat?}   (null clears one) -> { goals }
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
const MACROS = ['calories', 'protein', 'carbs', 'fat'];
const NAME_MAX = 300;
const NOTES_MAX = 2000;
const EXT_MAX = 200;
const BATCH_MAX = 500;
const NUM_MAX = 20000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export default {
  id: 'food',
  migrations: [
    {
      id: 'food-1',
      sql: `
        CREATE TABLE IF NOT EXISTS food_entries (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          date       TEXT    NOT NULL,
          meal       TEXT    NOT NULL,
          name       TEXT    NOT NULL,
          calories   REAL    NOT NULL DEFAULT 0,
          protein    REAL,
          carbs      REAL,
          fat        REAL,
          notes      TEXT    NOT NULL DEFAULT '',
          ext_id     TEXT UNIQUE,
          created_at TEXT    NOT NULL,
          updated_at TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS food_entries_date ON food_entries (date, created_at);
      `,
    },
  ],
  register(r, ctx) {
    const repo = foodRepo(ctx.db);
    const settings = ctx.settings;

    const goals = () => {
      const out = {};
      for (const k of MACROS) {
        const v = settings.get(`food.goal.${k}`, null);
        out[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
      }
      return out;
    };

    r.get('/api/food/day/:date', (req, res, { params }) => {
      const date = params.date === 'today' ? today() : parseDate(params.date, 'date');
      const entries = repo.day(date);
      return { date, entries, totals: totalsOf(entries), goals: goals() };
    });

    r.get('/api/food/days', (req, res, { query }) => {
      const to = query.to ? parseDate(query.to, 'to') : today();
      const from = query.from ? parseDate(query.from, 'from') : addDays(to, -29);
      if (from > to) throw new HttpError(400, 'from must be on or before to');
      if (daysBetween(from, to) > 400) throw new HttpError(400, 'at most 400 days at a time');
      return { from, to, days: repo.days(from, to), goals: goals() };
    });

    r.post('/api/food/entries', async (req, res) => {
      const body = await readJsonBody(req, { limit: 1024 * 1024 });
      if (Array.isArray(body.entries)) {
        if (!body.entries.length) throw new HttpError(400, 'entries is empty');
        if (body.entries.length > BATCH_MAX) throw new HttpError(400, `at most ${BATCH_MAX} entries at a time`);
        const clean = body.entries.map((e, i) => {
          try {
            return validateEntry(e, { partial: false });
          } catch (err) {
            if (err instanceof HttpError) throw new HttpError(400, `entries[${i}]: ${err.message}`);
            throw err;
          }
        });
        const { created, skipped } = repo.createMany(clean);
        return sendJson(res, 201, { entries: created, skipped });
      }
      sendJson(res, 201, { entry: repo.create(validateEntry(body, { partial: false })) });
    });

    r.patch('/api/food/entries/:id', async (req, res, { params }) => {
      const id = parseId(params.id);
      if (!repo.get(id)) throw new HttpError(404, 'entry not found');
      const patch = validateEntry(await readJsonBody(req), { partial: true });
      delete patch.ext_id;
      if (!Object.keys(patch).length) throw new HttpError(400, 'nothing to update');
      return { entry: repo.update(id, patch) };
    });

    r.delete('/api/food/entries/:id', (req, res, { params }) => {
      if (!repo.remove(parseId(params.id))) throw new HttpError(404, 'entry not found');
      sendEmpty(res, 204);
    });

    r.get('/api/food/recent', () => ({ foods: repo.recent(addDays(today(), -60)) }));

    r.get('/api/food/search', (req, res, { query }) => {
      const q = String(query.q || '').trim();
      if (!q) throw new HttpError(400, 'q is required');
      return { entries: repo.search(q.slice(0, 100)) };
    });

    r.get('/api/food/goals', () => ({ goals: goals() }));

    r.put('/api/food/goals', async (req) => {
      const body = await readJsonBody(req);
      const patch = {};
      for (const k of MACROS) {
        if (body[k] === undefined) continue;
        patch[`food.goal.${k}`] = body[k] === null ? null : num(body[k], k, { required: true });
      }
      if (!Object.keys(patch).length) throw new HttpError(400, 'send calories, protein, carbs and/or fat');
      settings.patch(patch);
      return { goals: goals() };
    });
  },
};

// ---------------------------------------------------------------- validation

// The PC's local calendar date, which is what "today" means to Jake.
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

function parseDate(raw, field) {
  const s = String(raw || '');
  if (!DATE_RE.test(s)) throw new HttpError(400, `${field} must be YYYY-MM-DD`);
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new HttpError(400, `${field} is not a real date`);
  return s;
}

function parseId(raw) {
  if (!/^\d{1,15}$/.test(String(raw))) return 0;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function num(v, field, { required = false } = {}) {
  if (v === null || v === undefined || v === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new HttpError(400, `${field} must be a number`);
  if (n < 0 || n > NUM_MAX) throw new HttpError(400, `${field} must be between 0 and ${NUM_MAX}`);
  return Math.round(n * 10) / 10;
}

function text(v, field, max, { required = false } = {}) {
  if (v === null || v === undefined) {
    if (required) throw new HttpError(400, `${field} is required`);
    return '';
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const s = v.trim();
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  if (CONTROL_CHARS.test(s)) throw new HttpError(400, `${field} contains control characters`);
  return s;
}

function validateEntry(body, { partial }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be an object');
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('date')) out.date = has('date') && body.date !== null && body.date !== 'today' ? parseDate(body.date, 'date') : today();
  if (!partial || has('meal')) {
    const meal = String(body.meal ?? '').trim().toLowerCase();
    if (!MEALS.includes(meal)) throw new HttpError(400, `meal must be one of ${MEALS.join(', ')}`);
    out.meal = meal;
  }
  if (!partial || has('name')) out.name = text(body.name, 'name', NAME_MAX, { required: true });
  if (!partial || has('calories')) out.calories = num(body.calories, 'calories', { required: true });
  for (const k of ['protein', 'carbs', 'fat']) if (!partial || has(k)) out[k] = num(body[k], k);
  if (!partial || has('notes')) out.notes = text(body.notes, 'notes', NOTES_MAX);
  if (has('ext_id') && body.ext_id !== null) out.ext_id = text(body.ext_id, 'ext_id', EXT_MAX) || null;
  return out;
}

// ---------------------------------------------------------------- data

function rowToEntry(row) {
  return {
    id: Number(row.id),
    date: row.date,
    meal: row.meal,
    name: row.name,
    calories: row.calories,
    protein: row.protein,
    carbs: row.carbs,
    fat: row.fat,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

function totalsOf(entries) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  for (const e of entries) for (const k of MACROS) t[k] += e[k] || 0;
  for (const k of MACROS) t[k] = round1(t[k]);
  return t;
}

function foodRepo(db) {
  const dayStmt = db.prepare(`SELECT * FROM food_entries WHERE date = ?
    ORDER BY CASE meal WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 WHEN 'dinner' THEN 2 ELSE 3 END, created_at, id`);
  const daysStmt = db.prepare(`SELECT date, SUM(calories) AS calories, SUM(protein) AS protein, SUM(carbs) AS carbs,
    SUM(fat) AS fat, COUNT(*) AS count FROM food_entries WHERE date BETWEEN ? AND ? GROUP BY date ORDER BY date`);
  const getStmt = db.prepare('SELECT * FROM food_entries WHERE id = ?');
  const extStmt = db.prepare('SELECT id FROM food_entries WHERE ext_id = ?');
  const insertStmt = db.prepare(`INSERT INTO food_entries (date, meal, name, calories, protein, carbs, fat, notes, ext_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateStmt = db.prepare(`UPDATE food_entries SET date = ?, meal = ?, name = ?, calories = ?, protein = ?, carbs = ?,
    fat = ?, notes = ?, updated_at = ? WHERE id = ?`);
  const deleteStmt = db.prepare('DELETE FROM food_entries WHERE id = ?');
  // The most recent macros for each name, ranked by how often it was eaten.
  const recentStmt = db.prepare(`
    SELECT f.name, f.meal, f.calories, f.protein, f.carbs, f.fat, g.times
    FROM (SELECT lower(name) AS k, COUNT(*) AS times, MAX(id) AS last_id FROM food_entries WHERE date >= ? GROUP BY lower(name)) g
    JOIN food_entries f ON f.id = g.last_id
    ORDER BY g.times DESC, f.id DESC LIMIT 16`);
  const searchStmt = db.prepare(`SELECT * FROM food_entries WHERE name LIKE ? ESCAPE '\\' ORDER BY date DESC, id DESC LIMIT 25`);

  const get = (id) => {
    if (!id) return null;
    const row = getStmt.get(id);
    return row ? rowToEntry(row) : null;
  };
  const insert = (e) => {
    const now = new Date().toISOString();
    const info = insertStmt.run(e.date, e.meal, e.name, e.calories, e.protein, e.carbs, e.fat, e.notes, e.ext_id || null, now, now);
    return get(Number(info.lastInsertRowid));
  };

  return {
    get,
    day: (date) => dayStmt.all(date).map(rowToEntry),
    days: (from, to) => daysStmt.all(from, to).map((r) => ({
      date: r.date,
      calories: round1(r.calories || 0),
      protein: round1(r.protein || 0),
      carbs: round1(r.carbs || 0),
      fat: round1(r.fat || 0),
      count: Number(r.count),
    })),
    create: (e) => {
      if (e.ext_id && extStmt.get(e.ext_id)) throw new HttpError(409, 'an entry with that ext_id already exists');
      return insert(e);
    },
    createMany(list) {
      const created = [];
      let skipped = 0;
      db.exec('BEGIN');
      try {
        for (const e of list) {
          if (e.ext_id && extStmt.get(e.ext_id)) { skipped += 1; continue; }
          created.push(insert(e));
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return { created, skipped };
    },
    update(id, patch) {
      const cur = get(id);
      if (!cur) return null;
      const n = { ...cur, ...patch };
      updateStmt.run(n.date, n.meal, n.name, n.calories, n.protein, n.carbs, n.fat, n.notes, new Date().toISOString(), id);
      return get(id);
    },
    remove(id) {
      if (!id) return false;
      return Number(deleteStmt.run(id).changes) > 0;
    },
    recent: (since) => recentStmt.all(since).map((r) => ({
      name: r.name, meal: r.meal, calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat, times: Number(r.times),
    })),
    search: (q) => searchStmt.all(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`).map(rowToEntry),
  };
}
