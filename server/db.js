// SQLite via node:sqlite (DatabaseSync): open, migrations, and the notes repository.
// Zero npm dependencies. The DB file lives in JAKESDATA_DATA/jakesdata.db, never in the repo.
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

// Append-only. Each entry runs once, inside a transaction, and is recorded in `migrations`.
const MIGRATIONS = [
  {
    id: 1,
    name: 'notes',
    sql: `
      CREATE TABLE IF NOT EXISTS notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        text       TEXT    NOT NULL,
        done       INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notes_done_created ON notes (done, created_at DESC);
    `,
  },
];

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'jakesdata.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  // Short: this server is the only writer, and the wait happens synchronously on the event
  // loop. A foreign lock (someone in `sqlite3 jakesdata.db`) surfaces as SQLITE_BUSY -> 503 instead.
  db.exec('PRAGMA busy_timeout = 250');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return {
    db,
    file,
    notes: notesRepo(db),
    close() {
      try { db.close(); } catch { /* already closed */ }
    },
  };
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(db.prepare('SELECT id FROM migrations').all().map((row) => Number(row.id)));
  const record = db.prepare('INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      record.run(migration.id, migration.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function rowToNote(row) {
  return {
    id: Number(row.id),
    text: row.text,
    done: Boolean(row.done),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function notesRepo(db) {
  // Open first (newest first), then done (newest first).
  const listStmt = db.prepare('SELECT * FROM notes ORDER BY done ASC, created_at DESC, id DESC');
  const getStmt = db.prepare('SELECT * FROM notes WHERE id = ?');
  const insertStmt = db.prepare('INSERT INTO notes (text, done, created_at, updated_at) VALUES (?, 0, ?, ?)');
  const updateStmt = db.prepare('UPDATE notes SET text = ?, done = ?, updated_at = ? WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM notes WHERE id = ?');

  const get = (id) => {
    const row = getStmt.get(id);
    return row ? rowToNote(row) : null;
  };

  return {
    list: () => listStmt.all().map(rowToNote),
    get,
    create(text) {
      const now = new Date().toISOString();
      const info = insertStmt.run(text, now, now);
      return get(Number(info.lastInsertRowid));
    },
    update(id, patch) {
      const current = get(id);
      if (!current) return null;
      const text = patch.text !== undefined ? patch.text : current.text;
      const done = patch.done !== undefined ? patch.done : current.done;
      updateStmt.run(text, done ? 1 : 0, new Date().toISOString(), id);
      return get(id);
    },
    remove(id) {
      const info = deleteStmt.run(id);
      return Number(info.changes) > 0;
    },
  };
}
