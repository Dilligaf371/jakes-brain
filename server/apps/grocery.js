// Grocery: a shopping list grouped by aisle, with a "Buy again" memory of past items.
// Routes:
//   GET    /api/grocery                 -> { items: [...], recent: [...], aisles: [...] }
//          items: still needed first (by aisle order, then newest), then in the cart
//          recent: up to 16 past items not on the list (needed or in the cart), most used first
//   POST   /api/grocery {name, qty?, aisle?} -> 201 { item }   (aisle omitted = remembered or guessed)
//   PATCH  /api/grocery/:id {name?, qty?, aisle?, got?} -> { item }
//   DELETE /api/grocery/:id              -> 204
//   POST   /api/grocery/clear            -> { removed }  deletes every item already in the cart
//   GET    /api/grocery/badge            -> { count: <still needed> }
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';

export const AISLES = [
  'Produce', 'Bakery', 'Meat & Seafood', 'Dairy & Eggs', 'Pantry',
  'Frozen', 'Snacks', 'Drinks', 'Household', 'Other',
];

const NAME_MAX = 200;
const QTY_MAX = 40;
const RECENT_LIMIT = 16;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const INVISIBLE = /[​‌‍⁠﻿]/g;

// First match wins, so more specific words come before broad ones ("ice cream" before "cream").
const GUESSES = [
  ['Frozen', ['frozen', 'ice cream', 'popsicle', 'pizza rolls', 'waffles']],
  ['Drinks', ['water', 'sparkling', 'soda', 'juice', 'coffee', 'tea', 'beer', 'wine', 'kombucha', 'seltzer', 'gatorade', 'lacroix', 'celsius', 'energy drink']],
  ['Dairy & Eggs', ['milk', 'egg', 'cheese', 'yogurt', 'yoghurt', 'butter', 'cream', 'cottage', 'kefir', 'half and half']],
  ['Meat & Seafood', ['chicken', 'beef', 'steak', 'pork', 'bacon', 'sausage', 'turkey', 'ham', 'salmon', 'tuna steak', 'shrimp', 'fish', 'ground', 'lamb']],
  ['Bakery', ['bread', 'bagel', 'bun', 'roll', 'tortilla', 'croissant', 'muffin', 'pita', 'sourdough']],
  ['Produce', ['apple', 'banana', 'berr', 'grape', 'lemon', 'lime', 'orange', 'avocado', 'tomato', 'potato', 'onion', 'garlic', 'lettuce', 'spinach', 'kale', 'carrot', 'celery', 'pepper', 'cucumber', 'broccoli', 'zucchini', 'mushroom', 'fruit', 'salad', 'herb', 'cilantro', 'basil', 'ginger', 'peach', 'pear', 'melon', 'mango', 'pineapple', 'corn', 'greens']],
  ['Household', ['paper towel', 'toilet paper', 'soap', 'detergent', 'trash bag', 'foil', 'wrap', 'sponge', 'shampoo', 'toothpaste', 'deodorant', 'tissue', 'napkin', 'cleaner', 'battery', 'batteries']],
  ['Snacks', ['chip', 'cracker', 'cookie', 'popcorn', 'pretzel', 'candy', 'chocolate', 'bar', 'nuts', 'almond', 'jerky', 'trail mix']],
  ['Pantry', ['rice', 'pasta', 'flour', 'sugar', 'oil', 'vinegar', 'sauce', 'salt', 'spice', 'cereal', 'oat', 'bean', 'can', 'soup', 'peanut butter', 'jam', 'honey', 'syrup', 'broth', 'tuna', 'ketchup', 'mustard', 'mayo', 'protein powder']],
];

export function guessAisle(name) {
  const lower = String(name).toLowerCase();
  for (const [aisle, words] of GUESSES) {
    if (words.some((word) => lower.includes(word))) return aisle;
  }
  return 'Other';
}

export default {
  id: 'grocery',
  migrations: [
    {
      id: 'grocery-1',
      sql: `
        CREATE TABLE IF NOT EXISTS grocery_items (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT    NOT NULL,
          qty        TEXT    NOT NULL DEFAULT '',
          aisle      TEXT    NOT NULL DEFAULT 'Other',
          got        INTEGER NOT NULL DEFAULT 0,
          created_at TEXT    NOT NULL,
          updated_at TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS grocery_items_got ON grocery_items (got, created_at DESC);
        CREATE TABLE IF NOT EXISTS grocery_history (
          key        TEXT    PRIMARY KEY,
          name       TEXT    NOT NULL,
          qty        TEXT    NOT NULL DEFAULT '',
          aisle      TEXT    NOT NULL,
          times      INTEGER NOT NULL DEFAULT 1,
          last_added TEXT    NOT NULL
        );
      `,
    },
  ],
  register(r, ctx) {
    const repo = groceryRepo(ctx.db);

    r.get('/api/grocery', () => ({ items: repo.list(), recent: repo.recent(), aisles: AISLES }));

    r.get('/api/grocery/badge', () => ({ count: repo.neededCount() }));

    r.post('/api/grocery', async (req, res) => {
      const body = await readJsonBody(req);
      const name = validateName(body.name);
      const qty = body.qty === undefined || body.qty === null ? '' : validateQty(body.qty);
      const aisle = body.aisle === undefined || body.aisle === null || body.aisle === ''
        ? (repo.rememberedAisle(name) || guessAisle(name))
        : validateAisle(body.aisle);
      sendJson(res, 201, { item: repo.create({ name, qty, aisle }) });
    });

    r.post('/api/grocery/clear', () => ({ removed: repo.clearGot() }));

    r.patch('/api/grocery/:id', async (req, res, { params }) => {
      const id = parseId(params.id);
      if (!repo.get(id)) throw new HttpError(404, 'item not found');
      const body = await readJsonBody(req);
      const patch = {};
      if (body.name !== undefined) patch.name = validateName(body.name);
      if (body.qty !== undefined) patch.qty = body.qty === null ? '' : validateQty(body.qty);
      if (body.aisle !== undefined) patch.aisle = validateAisle(body.aisle);
      if (body.got !== undefined) {
        if (typeof body.got !== 'boolean') throw new HttpError(400, 'got must be a boolean');
        patch.got = body.got;
      }
      if (!Object.keys(patch).length) throw new HttpError(400, 'nothing to update: send name, qty, aisle and/or got');
      const item = repo.update(id, patch);
      if (!item) throw new HttpError(404, 'item not found');
      return { item };
    });

    r.delete('/api/grocery/:id', (req, res, { params }) => {
      if (!repo.remove(parseId(params.id))) throw new HttpError(404, 'item not found');
      sendEmpty(res, 204);
    });
  },
};

function parseId(raw) {
  if (!/^\d{1,15}$/.test(String(raw))) return 0;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function cleanText(value, label, max, { required }) {
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string`);
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (required && !trimmed.replace(INVISIBLE, '').trim()) throw new HttpError(400, `${label} is required`);
  if (trimmed.length > max) throw new HttpError(400, `${label} is too long (max ${max} characters)`);
  if (CONTROL_CHARS.test(trimmed)) throw new HttpError(400, `${label} contains control characters`);
  return trimmed;
}

const validateName = (v) => cleanText(v, 'name', NAME_MAX, { required: true });
const validateQty = (v) => cleanText(typeof v === 'number' ? String(v) : v, 'qty', QTY_MAX, { required: false });

function validateAisle(value) {
  if (!AISLES.includes(value)) throw new HttpError(400, `aisle must be one of: ${AISLES.join(', ')}`);
  return value;
}

const keyOf = (name) => name.toLowerCase().replace(INVISIBLE, '').trim();

function rowToItem(row) {
  return {
    id: Number(row.id),
    name: row.name,
    qty: row.qty,
    aisle: row.aisle,
    got: Boolean(row.got),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function groceryRepo(db) {
  const aisleOrder = `CASE aisle ${AISLES.map((a, i) => `WHEN '${a.replace(/'/g, "''")}' THEN ${i}`).join(' ')} ELSE ${AISLES.length} END`;
  const listStmt = db.prepare(`SELECT * FROM grocery_items ORDER BY got ASC, ${aisleOrder}, created_at DESC, id DESC`);
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM grocery_items WHERE got = 0');
  const getStmt = db.prepare('SELECT * FROM grocery_items WHERE id = ?');
  const insertStmt = db.prepare('INSERT INTO grocery_items (name, qty, aisle, got, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)');
  const updateStmt = db.prepare('UPDATE grocery_items SET name = ?, qty = ?, aisle = ?, got = ?, updated_at = ? WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM grocery_items WHERE id = ?');
  const clearStmt = db.prepare('DELETE FROM grocery_items WHERE got = 1');
  const historyGet = db.prepare('SELECT aisle FROM grocery_history WHERE key = ?');
  const historyUpsert = db.prepare(`
    INSERT INTO grocery_history (key, name, qty, aisle, times, last_added) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET name = excluded.name, qty = excluded.qty, aisle = excluded.aisle,
      times = times + 1, last_added = excluded.last_added`);
  const historyAisle = db.prepare('UPDATE grocery_history SET aisle = ? WHERE key = ?');
  const recentStmt = db.prepare(`
    SELECT key, name, qty, aisle, times, last_added FROM grocery_history
    ORDER BY times DESC, last_added DESC LIMIT ${RECENT_LIMIT * 4}`);
  const listedNames = db.prepare('SELECT name FROM grocery_items');

  const get = (id) => {
    if (!id) return null;
    const row = getStmt.get(id);
    return row ? rowToItem(row) : null;
  };

  return {
    list: () => listStmt.all().map(rowToItem),
    neededCount: () => Number(countStmt.get().n),
    recent() {
      // Skip what is already on the list; the key match is done here so it uses the same
      // Unicode-aware lower-casing as keyOf().
      const onList = new Set(listedNames.all().map((row) => keyOf(row.name)));
      return recentStmt.all()
        .filter((row) => !onList.has(row.key))
        .slice(0, RECENT_LIMIT)
        .map((row) => ({ key: row.key, name: row.name, qty: row.qty, aisle: row.aisle, times: Number(row.times) }));
    },
    rememberedAisle(name) {
      const row = historyGet.get(keyOf(name));
      return row ? row.aisle : null;
    },
    get,
    create({ name, qty, aisle }) {
      const now = new Date().toISOString();
      const info = insertStmt.run(name, qty, aisle, now, now);
      historyUpsert.run(keyOf(name), name, qty, aisle, now);
      return get(Number(info.lastInsertRowid));
    },
    update(id, patch) {
      const current = get(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      updateStmt.run(next.name, next.qty, next.aisle, next.got ? 1 : 0, new Date().toISOString(), id);
      // Moving an item to another aisle teaches the list where it goes next time.
      if (patch.aisle !== undefined) historyAisle.run(next.aisle, keyOf(next.name));
      return get(id);
    },
    remove(id) {
      if (!id) return false;
      return Number(deleteStmt.run(id).changes) > 0;
    },
    clearGot: () => Number(clearStmt.run().changes),
  };
}
