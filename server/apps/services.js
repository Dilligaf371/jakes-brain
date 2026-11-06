// Services: UAE life admin read from the owner's mail by ICO — deliveries (Amazon, noon,
// Deliveroo, Instashop, Washmen…), bills (e&, du, DEWA…) and official matters (ICP, TAMM,
// UAE PASS, RTA…). ICO classifies sender + subject on the Mac and pushes only the extracted
// fields here; no mail body or address ever reaches this table. Routes:
//   GET   /api/services                  -> { events: [...] }  open first, newest first (max 200)
//   PUT   /api/services/events {events:[{ref, kind, provider, title, at?, done?}]} -> { upserted }
//         upsert by ref (ICO's message id). `done` only ever goes false -> true from a push, so
//         the owner's "done" is never undone by the next sync.
//   PATCH /api/services/events/:id {done} -> { event }
//   GET   /api/services/badge            -> { count: <open deliveries + bills + official> }
//   POST  /api/services/sms {sender, text, at?} -> { kept, event? }  one SMS forwarded by the
//         owner's iPhone Shortcuts automation; anything unrecognised (or a one-time code) is
//         dropped without being stored.
import { readJsonBody, sendJson, HttpError } from '../http.js';
import { classifySms } from './_sms_classifier.js';

const KINDS = new Set(['delivery', 'bill', 'official']);
const BATCH_MAX = 200;
const REF_MAX = 200;
const PROVIDER_MAX = 60;
const TITLE_MAX = 300;
const LIST_MAX = 200;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export default {
  id: 'services',
  migrations: [
    {
      id: 'services-1',
      sql: `
        CREATE TABLE IF NOT EXISTS service_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          ref        TEXT    NOT NULL UNIQUE,
          kind       TEXT    NOT NULL,
          provider   TEXT    NOT NULL,
          title      TEXT    NOT NULL,
          at         TEXT,
          done       INTEGER NOT NULL DEFAULT 0,
          created_at TEXT    NOT NULL,
          updated_at TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS service_events_open ON service_events (done, at DESC);
      `,
    },
  ],
  register(r, ctx) {
    const repo = servicesRepo(ctx.db);

    r.get('/api/services', () => ({ events: repo.list() }));

    r.get('/api/services/badge', () => ({ count: repo.openCount() }));

    r.put('/api/services/events', async (req) => {
      const body = await readJsonBody(req);
      if (!body || !Array.isArray(body.events)) throw new HttpError(400, 'events must be an array');
      if (body.events.length > BATCH_MAX) throw new HttpError(400, `too many events (max ${BATCH_MAX})`);
      const events = body.events.map(validateEvent);
      return { upserted: repo.upsertAll(events) };
    });

    r.post('/api/services/sms', async (req) => {
      const body = await readJsonBody(req);
      if (!body || typeof body.sender !== 'string' || typeof body.text !== 'string') {
        throw new HttpError(400, 'sender and text must be strings');
      }
      if (body.sender.length > 100 || body.text.length > 2000) throw new HttpError(400, 'sms too long');
      const at = body.at ? new Date(body.at) : new Date();
      const event = classifySms(body.sender, body.text, Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString());
      if (!event) return { kept: false };
      repo.upsertAll([validateEvent(event)]);
      return { kept: true, event: { kind: event.kind, provider: event.provider, title: event.title } };
    });

    r.patch('/api/services/events/:id', async (req, res, { params }) => {
      const id = parseId(params.id);
      if (!repo.get(id)) throw new HttpError(404, 'event not found');
      const body = await readJsonBody(req);
      if (typeof body.done !== 'boolean') throw new HttpError(400, 'done must be a boolean');
      return { event: repo.setDone(id, body.done) };
    });
  },
};

function parseId(raw) {
  if (!/^\d{1,15}$/.test(String(raw))) return 0;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function text(value, field, max) {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new HttpError(400, `${field} is required`);
  if (CONTROL_CHARS.test(trimmed)) throw new HttpError(400, `${field} contains control characters`);
  return trimmed.slice(0, max);
}

function validateEvent(e) {
  if (!e || typeof e !== 'object') throw new HttpError(400, 'each event must be an object');
  if (!KINDS.has(e.kind)) throw new HttpError(400, 'kind must be delivery, bill or official');
  let at = null;
  if (e.at !== undefined && e.at !== null) {
    const d = new Date(e.at);
    if (typeof e.at !== 'string' || Number.isNaN(d.getTime())) throw new HttpError(400, 'at must be an ISO date');
    at = d.toISOString();
  }
  if (e.done !== undefined && typeof e.done !== 'boolean') throw new HttpError(400, 'done must be a boolean');
  return {
    ref: text(e.ref, 'ref', REF_MAX),
    kind: e.kind,
    provider: text(e.provider, 'provider', PROVIDER_MAX),
    title: text(e.title, 'title', TITLE_MAX),
    at,
    done: e.done === true,
  };
}

function rowToEvent(row) {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    title: row.title,
    at: row.at,
    done: Boolean(row.done),
    updated_at: row.updated_at,
  };
}

function servicesRepo(db) {
  const listStmt = db.prepare(`SELECT * FROM service_events ORDER BY done ASC, COALESCE(at, created_at) DESC, id DESC LIMIT ${LIST_MAX}`);
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM service_events WHERE done = 0');
  const getStmt = db.prepare('SELECT * FROM service_events WHERE id = ?');
  // A push may finish an event (a delivery arrived) but never reopen one the owner closed.
  const upsertStmt = db.prepare(`
    INSERT INTO service_events (ref, kind, provider, title, at, done, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ref) DO UPDATE SET
      kind = excluded.kind, provider = excluded.provider, title = excluded.title,
      at = COALESCE(excluded.at, service_events.at),
      done = MAX(service_events.done, excluded.done),
      updated_at = excluded.updated_at`);
  const doneStmt = db.prepare('UPDATE service_events SET done = ?, updated_at = ? WHERE id = ?');

  const get = (id) => {
    if (!id) return null;
    const row = getStmt.get(id);
    return row ? rowToEvent(row) : null;
  };

  return {
    list: () => listStmt.all().map(rowToEvent),
    openCount: () => Number(countStmt.get().n),
    get,
    upsertAll(events) {
      const now = new Date().toISOString();
      for (const e of events) upsertStmt.run(e.ref, e.kind, e.provider, e.title, e.at, e.done ? 1 : 0, now, now);
      return events.length;
    },
    setDone(id, done) {
      doneStmt.run(done ? 1 : 0, new Date().toISOString(), id);
      return get(id);
    },
  };
}
