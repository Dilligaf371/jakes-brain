// Voice Memos: audio uploaded from the phone (or a file), transcribed on the PC with
// faster-whisper, and copied into Notes. Audio lives in DATA/media/voice.
// Routes: GET /api/voice, PUT /api/voice/upload, POST /api/voice/:id/retry, DELETE /api/voice/:id
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendJson, sendEmpty, saveRawBody, requestFilename, HttpError } from '../http.js';
import { now, parseId } from './_lib.js';

const EXT = ['m4a', 'mp3', 'wav', 'aac', 'caf', 'ogg', 'webm', 'mp4', 'mov'];
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'transcribe.py');
const noteTitle = (date) => `Voice memo, ${date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;

export default {
  id: 'voice',
  migrations: [{
    id: 'voice-1',
    sql: `
      CREATE TABLE IF NOT EXISTS voice_memos (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        file       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        duration   REAL,
        status     TEXT NOT NULL DEFAULT 'processing',
        transcript TEXT NOT NULL DEFAULT '',
        error      TEXT,
        note_id    INTEGER,
        created_at TEXT NOT NULL
      );`,
  }],
  register(r, { db, cfg, mediaDir, tools, log, expandHome }) {
    const dir = mediaDir('voice');
    const python = cfg.voice?.python ? expandHome(cfg.voice.python) : null;
    const get = (id) => db.prepare('SELECT * FROM voice_memos WHERE id = ?').get(id);

    async function transcribe(id) {
      const memo = get(id);
      if (!memo) return;
      const fail = (error) => db.prepare("UPDATE voice_memos SET status = 'failed', error = ? WHERE id = ?").run(String(error).slice(0, 300), id);
      if (!python || !fs.existsSync(python)) return fail('Transcription is not set up on this machine.');
      const out = await tools.run(python, [SCRIPT, path.join(dir, memo.file)], {
        timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, WHISPER_MODEL: cfg.voice?.model || 'small.en' },
      });
      if (out.code !== 0) return fail(out.timedOut ? 'Transcription took too long.' : (out.stderr || out.error || 'Transcription failed.').trim().split('\n').at(-1));
      let result;
      try {
        result = JSON.parse(out.stdout.trim().split('\n').at(-1));
      } catch {
        return fail('Transcription returned nothing usable.');
      }
      const transcript = String(result.text || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
      let noteId = memo.note_id;
      const hasNotes = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes'").get();
      if (transcript && !noteId && hasNotes) {
        const stamp = now();
        const made = db.prepare('INSERT INTO notes (title, body, pinned, created_at, updated_at) VALUES (?, ?, 0, ?, ?)').run(noteTitle(new Date(memo.created_at)), transcript, stamp, stamp);
        noteId = Number(made.lastInsertRowid);
      }
      db.prepare("UPDATE voice_memos SET status = 'done', transcript = ?, duration = ?, error = NULL, note_id = ? WHERE id = ?")
        .run(transcript, Number(result.duration) || null, noteId, id);
    }
    const enqueue = (id) => tools.queue(() => transcribe(id)).catch((err) => log.error(`voice ${id}: ${err?.message || err}`));

    // A restart mid-transcription would otherwise leave these spinning forever.
    for (const row of db.prepare("SELECT id FROM voice_memos WHERE status = 'processing'").all()) enqueue(row.id);

    r.get('/api/voice', () => ({ memos: db.prepare('SELECT * FROM voice_memos ORDER BY id DESC LIMIT 200').all() }));

    r.put('/api/voice/upload', async (req, res) => {
      const ext = path.extname(requestFilename(req) || '').slice(1).toLowerCase();
      if (!EXT.includes(ext)) throw new HttpError(400, `audio must be one of: ${EXT.join(', ')}`);
      const file = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
      const abs = path.join(dir, file);
      try {
        await saveRawBody(req, abs, { limit: 200 * 1024 * 1024 });
      } catch (err) {
        await fsp.rm(abs, { force: true });
        throw err;
      }
      const { size } = await fsp.stat(abs);
      if (!size) {
        await fsp.rm(abs, { force: true });
        throw new HttpError(400, 'that audio file is empty');
      }
      const made = db.prepare('INSERT INTO voice_memos (file, size, created_at) VALUES (?, ?, ?)').run(file, size, now());
      const id = Number(made.lastInsertRowid);
      enqueue(id);
      sendJson(res, 201, { memo: get(id) });
    });

    r.post('/api/voice/:id/retry', (req, res, { params }) => {
      const id = parseId(params.id);
      if (!get(id)) throw new HttpError(404, 'memo not found');
      db.prepare("UPDATE voice_memos SET status = 'processing', error = NULL WHERE id = ?").run(id);
      enqueue(id);
      return { memo: get(id) };
    });

    // The note copy stays: it may have been edited since.
    r.delete('/api/voice/:id', async (req, res, { params }) => {
      const id = parseId(params.id);
      const memo = get(id);
      if (!memo) throw new HttpError(404, 'memo not found');
      await fsp.rm(path.join(dir, memo.file), { force: true });
      db.prepare('DELETE FROM voice_memos WHERE id = ?').run(id);
      sendEmpty(res, 204);
    });
  },
};
