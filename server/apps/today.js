// Today: ICO's daily cockpit. One JSON brief per date (what ICO pushes in) plus a LIVE
// summary aggregated read-only from the other apps, so the screen is useful before any push.
// Table `today_brief(date PRIMARY KEY, data TEXT, updated_at)`; `data` = {headline, items:[{id,text,kind?,done}]}.
// Routes (the connector reads this header so ICO can push):
//   GET   /api/today                     -> { date, brief, summary }   date = the PC's local date;
//         brief = today's stored JSON (or null); summary = aggregated live + defensively from
//         other tables (today's food calories/protein + goals, open task count).
//   PUT   /api/today/brief {date?, headline?, items:[{text, kind?}]} -> { brief }
//         ICO pushes the brief here; replaces the row for that date (default today). Each item
//         is stored with a stable integer id (its index) and done:false.
//   PATCH /api/today/items/:index {done}  -> { brief }   toggle one brief item's done flag
//         (index into today's brief items); 404 if no brief or bad index.
//   GET   /api/today/badge                -> { count: <undone brief items for today> }
import { readJsonBody, sendJson, HttpError } from '../http.js';

const HEADLINE_MAX = 300;
const ITEM_TEXT_MAX = 500;
const KIND_MAX = 40;
const ITEMS_MAX = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export default {
  id: 'today',
  migrations: [
    {
      id: 'today-1',
      sql: `
        CREATE TABLE IF NOT EXISTS today_brief (
          date       TEXT PRIMARY KEY,
          data       TEXT NOT NULL,
          updated_at TEXT
        );
      `,
    },
  ],
  register(r, ctx) {
    const repo = briefRepo(ctx.db);

    r.get('/api/today', () => {
      const date = today();
      return { date, brief: repo.get(date), summary: buildSummary(ctx, date) };
    });

    r.put('/api/today/brief', async (req, res) => {
      const body = await readJsonBody(req);
      const date = body.date === undefined || body.date === null ? today() : parseDate(body.date);
      const brief = validateBrief(body);
      sendJson(res, 200, { brief: repo.put(date, brief) });
    });

    r.patch('/api/today/items/:index', async (req, res, { params }) => {
      const date = today();
      const brief = repo.get(date);
      if (!brief || !Array.isArray(brief.items)) throw new HttpError(404, 'no brief for today');
      const index = parseIndex(params.index);
      if (index === null || index >= brief.items.length) throw new HttpError(404, 'item not found');
      const body = await readJsonBody(req);
      if (typeof body.done !== 'boolean') throw new HttpError(400, 'done must be a boolean');
      const items = brief.items.map((it, i) => (i === index ? { ...it, done: body.done } : it));
      return { brief: repo.put(date, { ...brief, items }) };
    });

    r.get('/api/today/badge', () => {
      const brief = repo.get(today());
      const items = brief && Array.isArray(brief.items) ? brief.items : [];
      return { count: items.filter((it) => !it.done).length };
    });
  },
};

// ---------------------------------------------------------------- summary

// Aggregated LIVE from the other apps' tables. Each piece is wrapped so a table that does not
// exist yet (an app not built) never 500s — we just skip that part of the summary.
function buildSummary(ctx, date) {
  const summary = {};
  try {
    const row = ctx.db.prepare(
      'SELECT SUM(calories) AS calories, SUM(protein) AS protein FROM food_entries WHERE date = ?',
    ).get(date);
    summary.food = {
      calories: round1(row && row.calories ? row.calories : 0),
      protein: round1(row && row.protein ? row.protein : 0),
      goalCalories: numSetting(ctx, 'food.goal.calories'),
      goalProtein: numSetting(ctx, 'food.goal.protein'),
    };
  } catch { /* food app not installed yet */ }
  try {
    const row = ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE done = 0').get();
    summary.openTasks = Number(row.n);
  } catch { /* tasks app not installed yet */ }
  return summary;
}

function numSetting(ctx, key) {
  const v = ctx.settings.get(key, null);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const round1 = (n) => Math.round(Number(n) * 10) / 10;

// ---------------------------------------------------------------- validation

// The PC's local calendar date, which is what "today" means (copied from food.js).
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDate(raw) {
  const s = String(raw || '');
  if (!DATE_RE.test(s)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new HttpError(400, 'date is not a real date');
  return s;
}

function parseIndex(raw) {
  if (!/^\d{1,4}$/.test(String(raw))) return null;
  return Number(raw);
}

function str(v, field, max, { required = false } = {}) {
  if (v === undefined || v === null) {
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

function validateBrief(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be an object');
  const headline = str(body.headline, 'headline', HEADLINE_MAX);
  if (!Array.isArray(body.items)) throw new HttpError(400, 'items must be an array');
  if (body.items.length > ITEMS_MAX) throw new HttpError(400, `at most ${ITEMS_MAX} items`);
  const items = body.items.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, `items[${i}] must be an object`);
    const item = { id: i, text: str(raw.text, `items[${i}].text`, ITEM_TEXT_MAX, { required: true }), done: false };
    if (raw.kind !== undefined && raw.kind !== null) {
      const kind = str(raw.kind, `items[${i}].kind`, KIND_MAX);
      if (kind) item.kind = kind;
    }
    return item;
  });
  return { headline, items };
}

// ---------------------------------------------------------------- data

function briefRepo(db) {
  const getStmt = db.prepare('SELECT data FROM today_brief WHERE date = ?');
  const upsertStmt = db.prepare(`INSERT INTO today_brief (date, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`);

  const get = (date) => {
    const row = getStmt.get(date);
    if (!row) return null;
    try {
      return JSON.parse(row.data);
    } catch {
      return null;
    }
  };

  return {
    get,
    put(date, brief) {
      upsertStmt.run(date, JSON.stringify(brief), new Date().toISOString());
      return get(date);
    },
  };
}
