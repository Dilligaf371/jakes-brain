// SQLite via node:sqlite (DatabaseSync): open, the migrations registry, and the core
// settings repository. Zero npm dependencies. The DB file lives in JAKESDATA_DATA/jakesdata.db,
// never in the repo.
//
// Migrations: table `migrations(id TEXT PRIMARY KEY, applied_at TEXT)`. Ids are strings like
// 'core-2' or 'notes-1'. Core migrations run first (here), then index.js applies each app
// module's `migrations` in module-id alphabetical order via `store.applyMigrations(id, list)`.
// Each migration is `{ id, sql }` (a SQL script) or `{ id, up(db) }` (JS, for conditional DDL);
// it runs once, inside a transaction, and is recorded.
import fs from 'node:fs';
import path from 'node:path';

// Node 22 still prints an ExperimentalWarning when node:sqlite is imported. Drop just
// that one warning and leave every other warning on the default handler.
const defaultWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning && warning.name === 'ExperimentalWarning' && /sqlite/i.test(String(warning.message))) return;
  for (const listener of defaultWarningListeners) listener.call(process, warning);
});

const { DatabaseSync } = await import('node:sqlite');

export const CORE_MIGRATIONS = [
  {
    // The v1 schema (the checklist table, still called `notes` here) + the settings table.
    // Everything is IF NOT EXISTS so it is a no-op on a database that v1 already created.
    id: 'core-1',
    sql: `
      CREATE TABLE IF NOT EXISTS notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        text       TEXT    NOT NULL,
        done       INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notes_done_created ON notes (done, created_at DESC);
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    // The v1 checklist becomes the Tasks app's table, freeing `notes` for the Notes app
    // (its own migration `notes-1` runs after this). Guarded: only when `notes` exists and
    // `tasks` does not.
    id: 'core-2',
    up(db) {
      if (tableExists(db, 'notes') && !tableExists(db, 'tasks')) {
        db.exec('ALTER TABLE notes RENAME TO tasks');
        db.exec('DROP INDEX IF EXISTS notes_done_created');
        db.exec('CREATE INDEX IF NOT EXISTS tasks_done_created ON tasks (done, created_at DESC)');
      }
    },
  },
];

export function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

// node:sqlite exposes SQLite's primary result code as `errcode`
// (5 = SQLITE_BUSY, 6 = SQLITE_LOCKED): another process holds the write lock.
export function isDbBusy(err) {
  return Boolean(err) && (err.errcode === 5 || err.errcode === 6);
}

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'jakesdata.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  // Short: this server is the only writer, and the wait happens synchronously on the event
  // loop. A foreign lock (someone in `sqlite3 jakesdata.db`) surfaces as SQLITE_BUSY -> 503 instead.
  db.exec('PRAGMA busy_timeout = 250');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  ensureMigrationsTable(db);
  const appliedCore = applyMigrations(db, 'core', CORE_MIGRATIONS);
  const store = {
    db,
    file,
    appliedCore, // core migration ids applied by this open (index.js logs them)
    // Applies a module's migrations that have not run yet; returns the ids applied now.
    applyMigrations(moduleId, migrations) {
      return applyMigrations(db, moduleId, migrations);
    },
    appliedMigrations() {
      return db.prepare('SELECT id, applied_at FROM migrations ORDER BY applied_at, id').all();
    },
    settings: settingsRepo(db),
    close() {
      try { db.close(); } catch { /* already closed */ }
    },
  };
  return store;
}

// v1 recorded migrations as `migrations(id INTEGER, name TEXT, applied_at)` with one row
// (1, 'notes'). v2 ids are strings, so that table is rebuilt; nothing has to be carried over
// because core-1 is idempotent over the v1 schema.
function ensureMigrationsTable(db) {
  const cols = db.prepare("PRAGMA table_info('migrations')").all();
  const create = () => db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  if (cols.length === 0) return create();
  const idCol = cols.find((c) => c.name === 'id');
  const v1Shape = cols.some((c) => c.name === 'name') || (idCol && /INT/i.test(String(idCol.type || '')));
  if (!v1Shape) return;
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE migrations RENAME TO migrations_v1');
    create();
    db.exec('DROP TABLE migrations_v1');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function applyMigrations(db, moduleId, migrations) {
  if (migrations == null) return [];
  if (!Array.isArray(migrations)) throw new TypeError(`${moduleId}: migrations must be an array`);
  const applied = new Set(db.prepare('SELECT id FROM migrations').all().map((row) => String(row.id)));
  const record = db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)');
  const done = [];
  for (const migration of migrations) {
    const id = migration && migration.id;
    if (typeof id !== 'string' || !id.trim()) throw new TypeError(`${moduleId}: every migration needs a string id`);
    if (!id.startsWith(`${moduleId}-`)) {
      console.warn(`[jakes-data] ${moduleId}: migration id "${id}" should start with "${moduleId}-"`);
    }
    if (applied.has(id)) continue;
    const hasUp = typeof migration.up === 'function';
    const hasSql = typeof migration.sql === 'string';
    if (!hasUp && !hasSql) throw new TypeError(`${moduleId}: migration "${id}" needs sql or up(db)`);
    db.exec('BEGIN');
    try {
      if (hasUp) migration.up(db);
      else db.exec(migration.sql);
      record.run(id, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      err.message = `migration ${id} failed: ${err.message}`;
      throw err;
    }
    applied.add(id);
    done.push(id);
  }
  return done;
}

// ---------------------------------------------------------------- settings

// `settings(key, value, updated_at)`; values are JSON-encoded scalars (string / number /
// boolean). GET returns them decoded; a null in PATCH deletes the key.
function settingsRepo(db) {
  const allStmt = db.prepare('SELECT key, value FROM settings ORDER BY key');
  const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const putStmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const delStmt = db.prepare('DELETE FROM settings WHERE key = ?');

  const decode = (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };

  return {
    // A null-prototype object: a key such as "__proto__" (rejected on write since v2, but an
    // old row could exist) is an ordinary entry here instead of hitting the prototype setter.
    all() {
      const out = Object.create(null);
      for (const row of allStmt.all()) out[row.key] = decode(row.value);
      return out;
    },
    get(key, fallback = undefined) {
      const row = getStmt.get(key);
      return row ? decode(row.value) : fallback;
    },
    // patch: { key: value | null }; applied atomically.
    patch(patch) {
      const now = new Date().toISOString();
      db.exec('BEGIN');
      try {
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delStmt.run(key);
          else putStmt.run(key, JSON.stringify(value), now);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
