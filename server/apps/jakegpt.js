// JakeGPT: private ChatGPT over the PC's Ollama (cfg.ollamaUrl, env JAKESDATA_OLLAMA).
// Tables gpt_conversations + gpt_messages (migration jakegpt-1). Routes:
//   GET    /api/jakegpt/models                       -> { models: [{ name, size }], default }
//                                                       503 { error: "Ollama is not running" } when unreachable
//   GET    /api/jakegpt/conversations                -> { conversations: [...] }  newest activity first
//   POST   /api/jakegpt/conversations {model?}       -> 201 { conversation }
//   GET    /api/jakegpt/conversations/:id            -> { conversation, messages: [...] }
//   PATCH  /api/jakegpt/conversations/:id {title?, model?} -> { conversation }
//   DELETE /api/jakegpt/conversations/:id            -> 204 (messages cascade; an in-flight reply is aborted)
//   POST   /api/jakegpt/conversations/:id/messages {content}
//          saves the user message (auto-titles an untitled conversation from its first 40 chars),
//          calls Ollama POST /api/chat with stream: true (system prompt from cfg.gpt.system + the
//          full history) and streams application/x-ndjson, one JSON object per line:
//            { "delta": "text" } ...  { "done": true, "message_id": n, "title": "..." }
//          or { "error": "message" } as the last line when nothing could be saved. The assistant
//          message is saved when Ollama finishes, or whatever was received when the client goes
//          away mid-stream. Ollama unreachable before anything streamed -> the user message is
//          rolled back and the reply is a plain 503 JSON error (502 when Ollama answered with an
//          error, e.g. an unknown model). 120 s idle timeout on the Ollama side.
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';

const TITLE_MAX = 120;
const AUTO_TITLE_LEN = 40;
const CONTENT_MAX = 32_000;
const MODEL_MAX = 128;
// Ollama model names: [namespace/]name[:tag], alphanumerics plus . _ -
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const TAGS_TIMEOUT_MS = 4_000;
const IDLE_MS = 120_000;
const ROLES = new Set(['user', 'assistant', 'system']);
// C0 controls other than \t \n \r, plus DEL (node:sqlite returns text as a C string: a NUL would truncate it).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// Embedding models cannot chat; Ollama reports them with a BERT family.
const EMBED_FAMILY_RE = /bert/i;

export default {
  id: 'jakegpt',
  migrations: [
    {
      id: 'jakegpt-1',
      sql: `
        CREATE TABLE IF NOT EXISTS gpt_conversations (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          title      TEXT,
          model      TEXT    NOT NULL,
          created_at TEXT    NOT NULL,
          updated_at TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS gpt_conversations_updated ON gpt_conversations (updated_at DESC);
        CREATE TABLE IF NOT EXISTS gpt_messages (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL REFERENCES gpt_conversations(id) ON DELETE CASCADE,
          role            TEXT    NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
          content         TEXT    NOT NULL,
          created_at      TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS gpt_messages_conversation ON gpt_messages (conversation_id, id);
      `,
    },
  ],

  register(r, ctx) {
    const repo = gptRepo(ctx.db);
    const ollamaUrl = String((ctx.cfg && ctx.cfg.ollamaUrl) || process.env.JAKESDATA_OLLAMA || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const gptCfg = (ctx.cfg && ctx.cfg.gpt && typeof ctx.cfg.gpt === 'object') ? ctx.cfg.gpt : {};
    const systemPrompt = typeof gptCfg.system === 'string' && gptCfg.system.trim() ? gptCfg.system.trim() : null;
    // conversation id -> AbortController of the reply currently streaming (one per conversation)
    const active = new Map();

    // The preferred model: settings gpt.model, else cfg.gpt.defaultModel (both may name a
    // model that is not installed; see resolveDefault for the Ollama-aware pick).
    function preferredModels() {
      const list = [ctx.settings && ctx.settings.get('gpt.model'), gptCfg.defaultModel];
      return list.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim());
    }

    function resolveDefault(names) {
      const prefs = preferredModels();
      for (const pref of prefs) {
        const hit = names.find((n) => n === pref || n === `${pref}:latest`);
        if (hit) return hit;
      }
      return names[0] || prefs[0] || null;
    }

    async function listModels() {
      let data;
      try {
        data = await ctx.tools.fetchJson(`${ollamaUrl}/api/tags`, { timeout: TAGS_TIMEOUT_MS });
      } catch (err) {
        if (err && err.status === 0) throw new HttpError(503, 'Ollama is not running');
        throw new HttpError(502, `Ollama: ${err && err.message ? err.message : err}`);
      }
      const raw = data && Array.isArray(data.models) ? data.models : [];
      const models = raw
        .filter((m) => m && typeof (m.name || m.model) === 'string')
        .filter((m) => !EMBED_FAMILY_RE.test(String((m.details && m.details.family) || '')) && !/embed/i.test(String(m.name || m.model)))
        .map((m) => ({ name: String(m.name || m.model), size: Number(m.size) || 0 }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { models, default: resolveDefault(models.map((m) => m.name)) };
    }

    r.get('/api/jakegpt/models', () => listModels());

    r.get('/api/jakegpt/conversations', () => ({ conversations: repo.list() }));

    r.post('/api/jakegpt/conversations', async (req, res) => {
      const body = await readJsonBody(req);
      let model;
      if (body.model !== undefined && body.model !== null) model = validateModel(body.model);
      else model = preferredModels()[0];
      if (!model) throw new HttpError(400, 'model is required (no default model is configured)');
      sendJson(res, 201, { conversation: repo.create(model) });
    });

    r.get('/api/jakegpt/conversations/:id', (req, res, { params }) => {
      const conversation = repo.get(parseId(params.id));
      if (!conversation) throw new HttpError(404, 'conversation not found');
      return { conversation, messages: repo.messages(conversation.id) };
    });

    r.patch('/api/jakegpt/conversations/:id', async (req, res, { params }) => {
      const id = parseId(params.id);
      if (!repo.get(id)) throw new HttpError(404, 'conversation not found');
      const body = await readJsonBody(req);
      const patch = {};
      if (body.title !== undefined) patch.title = validateTitle(body.title);
      if (body.model !== undefined) patch.model = validateModel(body.model);
      if (patch.title === undefined && patch.model === undefined) throw new HttpError(400, 'nothing to update: send title and/or model');
      const conversation = repo.update(id, patch);
      if (!conversation) throw new HttpError(404, 'conversation not found');
      return { conversation };
    });

    r.delete('/api/jakegpt/conversations/:id', (req, res, { params }) => {
      const id = parseId(params.id);
      if (!repo.remove(id)) throw new HttpError(404, 'conversation not found');
      const inflight = active.get(id);
      if (inflight) inflight.abort(); // the stream handler sees the conversation is gone and saves nothing
      sendEmpty(res, 204);
    });

    r.post('/api/jakegpt/conversations/:id/messages', async (req, res, { params }) => {
      const id = parseId(params.id);
      const conv = repo.get(id);
      if (!conv) throw new HttpError(404, 'conversation not found');
      const body = await readJsonBody(req);
      const content = validateContent(body.content);
      if (active.has(id)) throw new HttpError(409, 'a reply is already streaming for this conversation');

      // 1. Save the user message (+ auto-title) before talking to Ollama.
      const userMessage = repo.addMessage(id, 'user', content);
      const autoTitled = conv.title ? null : autoTitle(content);
      if (autoTitled) repo.update(id, { title: autoTitled }, { touch: false });
      const rollback = () => {
        repo.deleteMessage(userMessage.id);
        if (!repo.get(id)) return;
        if (autoTitled) repo.update(id, { title: null }, { touch: false });
        repo.setUpdatedAt(id, conv.updated_at); // a send that never happened must not reorder the list
      };

      const history = repo.messages(id).map((m) => ({ role: m.role, content: m.content }));
      const messages = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...history] : history;

      // 2. Call Ollama. One AbortController covers the idle timeout, the client going away
      //    and DELETE of the conversation mid-stream.
      const ctrl = new AbortController();
      active.set(id, ctrl);
      let idleTimer = 0;
      let idleFired = false;
      let clientGone = false;
      let finished = false;
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleFired = true;
          ctrl.abort();
        }, IDLE_MS);
      };
      const cleanup = () => {
        clearTimeout(idleTimer);
        if (active.get(id) === ctrl) active.delete(id);
      };
      // IncomingMessage 'close' fires once the request body is consumed (Node >= 16), so the
      // client going away is detected on the response: 'close' before we finished it.
      res.on('close', () => {
        if (finished) return;
        clientGone = true;
        ctrl.abort();
      });
      res.on('error', () => {});
      if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);

      let upstream;
      try {
        armIdle();
        upstream = await fetch(`${ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
          body: JSON.stringify({ model: conv.model, messages, stream: true }),
          signal: ctrl.signal,
        });
      } catch (err) {
        cleanup();
        finished = true;
        if (clientGone) return; // nothing to answer; the user message stays (it was sent)
        rollback();
        if (idleFired) throw new HttpError(504, 'Ollama did not answer within 120 s');
        if (repo.get(id) === null) throw new HttpError(404, 'conversation not found');
        throw new HttpError(503, 'Ollama is not running');
      }
      if (!upstream.ok) {
        cleanup();
        finished = true;
        let detail = `HTTP ${upstream.status}`;
        try {
          const text = await upstream.text();
          try {
            const parsed = JSON.parse(text);
            if (parsed && parsed.error) detail = String(parsed.error);
          } catch {
            if (text.trim()) detail = text.trim().slice(0, 200);
          }
        } catch { /* keep the status */ }
        if (clientGone) return;
        rollback();
        throw new HttpError(502, `Ollama: ${detail}`);
      }

      // 3. Stream the deltas back as NDJSON.
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      const send = (obj) => {
        if (clientGone || res.destroyed || res.writableEnded) return;
        res.write(`${JSON.stringify(obj)}\n`);
      };

      let text = '';
      let errorMsg = null;
      let sawDone = false;
      const handleLine = (line) => {
        if (!line.trim()) return false;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          return false;
        }
        if (obj && obj.error) {
          errorMsg = String(obj.error);
          return true;
        }
        const delta = obj && obj.message && typeof obj.message.content === 'string' ? obj.message.content : '';
        if (delta) {
          text += delta;
          send({ delta });
        }
        if (obj && obj.done) {
          sawDone = true;
          return true;
        }
        return false;
      };
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of upstream.body) {
          armIdle();
          buffer += decoder.decode(chunk, { stream: true });
          let stop = false;
          let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (handleLine(line)) {
              stop = true;
              break;
            }
          }
          if (stop) break;
        }
        if (!sawDone && !errorMsg) {
          buffer += decoder.decode();
          if (buffer.trim()) handleLine(buffer);
        }
      } catch (err) {
        if (!clientGone && !idleFired && !errorMsg) errorMsg = `Ollama stream failed: ${err && err.message ? err.message : err}`;
      }
      cleanup();
      if (idleFired) errorMsg = errorMsg || 'Ollama stopped responding (120 s idle)';
      else if (!sawDone && !errorMsg && !clientGone) errorMsg = 'Ollama ended the reply early';

      // 4. Save what we have (the whole reply, or the part received before the client left).
      let messageId = null;
      const still = repo.get(id);
      if (still) {
        if (text) messageId = repo.addMessage(id, 'assistant', text).id;
        else repo.update(id, {}, { touch: true });
      }
      finished = true;
      if (clientGone) {
        if (text) ctx.log(`conversation ${id}: client left mid-reply, saved ${text.length} chars`);
        return;
      }
      if (errorMsg && !still) errorMsg = 'conversation was deleted';
      if (messageId) send({ done: true, message_id: messageId, title: still.title, ...(errorMsg ? { error: errorMsg } : {}) });
      else send({ error: errorMsg || 'Ollama returned an empty reply' });
      res.end();
    });
  },
};

// ---------------------------------------------------------------- validation

function parseId(raw) {
  if (!/^\d{1,15}$/.test(String(raw))) return 0;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function validateModel(model) {
  if (typeof model !== 'string') throw new HttpError(400, 'model must be a string');
  const trimmed = model.trim();
  if (!trimmed) throw new HttpError(400, 'model is required');
  if (trimmed.length > MODEL_MAX || !MODEL_RE.test(trimmed)) throw new HttpError(400, 'model is not a valid Ollama model name');
  return trimmed;
}

function validateTitle(title) {
  if (typeof title !== 'string') throw new HttpError(400, 'title must be a string');
  const trimmed = title.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new HttpError(400, 'title is required');
  if (trimmed.length > TITLE_MAX) throw new HttpError(400, `title is too long (max ${TITLE_MAX} characters)`);
  if (CONTROL_CHARS.test(trimmed)) throw new HttpError(400, 'title contains control characters');
  return trimmed;
}

function validateContent(content) {
  if (typeof content !== 'string') throw new HttpError(400, 'content must be a string');
  const trimmed = content.replace(/\r\n?/g, '\n').trim();
  if (!trimmed) throw new HttpError(400, 'content is required');
  if (trimmed.length > CONTENT_MAX) throw new HttpError(400, `content is too long (max ${CONTENT_MAX} characters)`);
  if (CONTROL_CHARS.test(trimmed)) throw new HttpError(400, 'content contains control characters');
  return trimmed;
}

// The first 40 characters of the first user message, whitespace collapsed; an ellipsis
// replaces the 40th character when it was cut.
export function autoTitle(content) {
  const line = String(content || '').replace(/\s+/g, ' ').trim();
  if (line.length <= AUTO_TITLE_LEN) return line || null;
  return `${line.slice(0, AUTO_TITLE_LEN - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------- repo

function rowToConversation(row) {
  const out = {
    id: Number(row.id),
    title: row.title == null ? null : String(row.title),
    model: String(row.model),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.message_count !== undefined) out.message_count = Number(row.message_count);
  return out;
}

function rowToMessage(row) {
  return {
    id: Number(row.id),
    role: ROLES.has(row.role) ? row.role : 'assistant',
    content: String(row.content),
    created_at: row.created_at,
  };
}

function gptRepo(db) {
  const listStmt = db.prepare(`
    SELECT c.id, c.title, c.model, c.created_at, c.updated_at,
           (SELECT COUNT(*) FROM gpt_messages m WHERE m.conversation_id = c.id) AS message_count
    FROM gpt_conversations c
    ORDER BY c.updated_at DESC, c.id DESC
  `);
  const getStmt = db.prepare('SELECT * FROM gpt_conversations WHERE id = ?');
  const insertStmt = db.prepare('INSERT INTO gpt_conversations (title, model, created_at, updated_at) VALUES (NULL, ?, ?, ?)');
  const updateStmt = db.prepare('UPDATE gpt_conversations SET title = ?, model = ?, updated_at = ? WHERE id = ?');
  const touchStmt = db.prepare('UPDATE gpt_conversations SET updated_at = ? WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM gpt_conversations WHERE id = ?');
  const messagesStmt = db.prepare('SELECT id, role, content, created_at FROM gpt_messages WHERE conversation_id = ? ORDER BY id ASC');
  const insertMsgStmt = db.prepare('INSERT INTO gpt_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)');
  const getMsgStmt = db.prepare('SELECT id, role, content, created_at FROM gpt_messages WHERE id = ?');
  const deleteMsgStmt = db.prepare('DELETE FROM gpt_messages WHERE id = ?');

  const get = (id) => {
    if (!id) return null;
    const row = getStmt.get(id);
    return row ? rowToConversation(row) : null;
  };

  return {
    list: () => listStmt.all().map(rowToConversation),
    get,
    create(model) {
      const now = new Date().toISOString();
      const info = insertStmt.run(model, now, now);
      return get(Number(info.lastInsertRowid));
    },
    // patch: { title?: string|null, model?: string }. touch=true bumps updated_at (message
    // activity); a rename / model change alone keeps the list order.
    update(id, patch, { touch = false } = {}) {
      const current = get(id);
      if (!current) return null;
      const title = patch.title !== undefined ? patch.title : current.title;
      const model = patch.model !== undefined ? patch.model : current.model;
      updateStmt.run(title, model, touch ? new Date().toISOString() : current.updated_at, id);
      return get(id);
    },
    remove(id) {
      if (!id) return false;
      const info = deleteStmt.run(id);
      return Number(info.changes) > 0;
    },
    setUpdatedAt(id, iso) {
      touchStmt.run(iso, id);
    },
    messages: (id) => messagesStmt.all(id).map(rowToMessage),
    addMessage(conversationId, role, content) {
      const now = new Date().toISOString();
      const info = insertMsgStmt.run(conversationId, role, content, now);
      touchStmt.run(now, conversationId);
      return rowToMessage(getMsgStmt.get(Number(info.lastInsertRowid)));
    },
    deleteMessage(id) {
      const info = deleteMsgStmt.run(id);
      return Number(info.changes) > 0;
    },
  };
}
