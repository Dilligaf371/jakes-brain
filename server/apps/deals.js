// Deals: brand deals with deliverables, due dates, invoices, and what is owed. A due date is
// mirrored into Calendar as an all-day event. Routes: GET/POST /api/deals, GET/PATCH/DELETE /api/deals/:id
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';
import { now, parseId, text, day } from './_lib.js';

const STATUSES = ['talking', 'signed', 'delivered', 'invoiced', 'paid'];

export default {
  id: 'deals',
  migrations: [{
    id: 'deals-1',
    sql: `
      CREATE TABLE IF NOT EXISTS deals (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        brand             TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'talking',
        amount            REAL,
        due_date          TEXT,
        deliverables      TEXT NOT NULL DEFAULT '',
        invoice           TEXT NOT NULL DEFAULT '',
        notes             TEXT NOT NULL DEFAULT '',
        calendar_event_id INTEGER,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );`,
  }],
  register(r, { db }) {
    const get = (id) => db.prepare('SELECT * FROM deals WHERE id = ?').get(id);
    const need = (id) => {
      const deal = get(id);
      if (!deal) throw new HttpError(404, 'deal not found');
      return deal;
    };

    function clean(body, base = {}) {
      const merged = { ...base, ...body };
      const amount = merged.amount === '' || merged.amount === undefined ? null : merged.amount;
      if (amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1e9)) {
        throw new HttpError(400, 'amount must be a positive number');
      }
      const status = merged.status === undefined ? 'talking' : merged.status;
      if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
      return {
        brand: text(merged.brand, 'brand', { max: 120, required: true }),
        status,
        amount,
        due_date: day(merged.due_date, 'due_date'),
        deliverables: text(merged.deliverables, 'deliverables', { max: 4000 }),
        invoice: text(merged.invoice, 'invoice', { max: 120 }),
        notes: text(merged.notes, 'notes', { max: 8000 }),
      };
    }

    // Keep one all-day Calendar event per open deal with a due date.
    function syncCalendar(id) {
      const deal = need(id);
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='calendar_events'").get();
      if (!exists) return;
      const wanted = deal.due_date && deal.status !== 'paid';
      if (!wanted) {
        if (deal.calendar_event_id) {
          db.prepare('DELETE FROM calendar_events WHERE id = ?').run(deal.calendar_event_id);
          db.prepare('UPDATE deals SET calendar_event_id = NULL WHERE id = ?').run(id);
        }
        return;
      }
      const title = `${deal.brand} due`;
      const updated = deal.calendar_event_id
        ? db.prepare('UPDATE calendar_events SET title = ?, date = ?, updated_at = ? WHERE id = ?').run(title, deal.due_date, now(), deal.calendar_event_id)
        : { changes: 0 };
      if (!updated.changes) {
        const stamp = now();
        const made = db.prepare("INSERT INTO calendar_events (title, date, all_day, notes, created_at, updated_at) VALUES (?, ?, 1, 'From Deals', ?, ?)").run(title, deal.due_date, stamp, stamp);
        db.prepare('UPDATE deals SET calendar_event_id = ? WHERE id = ?').run(Number(made.lastInsertRowid), id);
      }
    }

    r.get('/api/deals', () => {
      const deals = db.prepare(`SELECT * FROM deals ORDER BY status = 'paid', due_date IS NULL, due_date, id DESC`).all();
      const sum = (states) => deals.filter((d) => states.includes(d.status)).reduce((total, d) => total + (d.amount || 0), 0);
      return { deals, summary: { owed: sum(['delivered', 'invoiced']), upcoming: sum(['talking', 'signed']), paid: sum(['paid']) } };
    });

    r.post('/api/deals', async (req, res) => {
      const d = clean(await readJsonBody(req));
      const stamp = now();
      const made = db.prepare(`INSERT INTO deals (brand, status, amount, due_date, deliverables, invoice, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(d.brand, d.status, d.amount, d.due_date, d.deliverables, d.invoice, d.notes, stamp, stamp);
      const id = Number(made.lastInsertRowid);
      syncCalendar(id);
      sendJson(res, 201, { deal: get(id) });
    });

    r.get('/api/deals/:id', (req, res, { params }) => ({ deal: need(parseId(params.id)) }));

    r.patch('/api/deals/:id', async (req, res, { params }) => {
      const id = parseId(params.id);
      const current = need(id);
      const d = clean(await readJsonBody(req), current);
      db.prepare(`UPDATE deals SET brand = ?, status = ?, amount = ?, due_date = ?, deliverables = ?, invoice = ?, notes = ?, updated_at = ? WHERE id = ?`)
        .run(d.brand, d.status, d.amount, d.due_date, d.deliverables, d.invoice, d.notes, now(), id);
      syncCalendar(id);
      return { deal: get(id) };
    });

    r.delete('/api/deals/:id', (req, res, { params }) => {
      const id = parseId(params.id);
      const deal = need(id);
      if (deal.calendar_event_id) db.prepare('DELETE FROM calendar_events WHERE id = ?').run(deal.calendar_event_id);
      db.prepare('DELETE FROM deals WHERE id = ?').run(id);
      sendEmpty(res, 204);
    });
  },
};
