// Connector: lets Claude (claude.ai, the Claude phone app, Claude Code) read and change Jake's
// Brain the way it does Notion, as a remote MCP server ("custom connector").
//
// It is a SECOND listener, separate from the app on :4800. It binds 127.0.0.1 only, so the
// one way in from outside is the tunnel on this PC (deploy/connector/). It answers POST /mcp for
// whoever signed in, plus the sign-in paths in _connector_auth.js; every other path is a 404.
// Nothing here is reachable without Jake's password, and the address itself holds no secret.
//
// Tools call this server's own JSON API over loopback, so they get exactly the same validation
// as the app. To give Claude a new ability, add an entry to TOOLS below.
//
//   JAKESDATA_CONNECTOR_PORT   (4801; when JAKESDATA_PORT is set and this is not: that port + 1;
//                               0 turns the connector off)
//
// Routes on the main (LAN-only) server, for the Settings screen:
//   GET    /api/connector           -> { port, publicUrl, url, listening, lastCall, passwordSet,
//                                          passwordMin, lockedUntil, signedIn: [{ name, lastUsed }] }
//   PUT    /api/connector/password  {password} -> same; changing it signs everything out
//   DELETE /api/connector/sessions  -> same, with everything signed out
//   (the public address is the setting `connector.publicUrl`, e.g. https://jake.ngrok-free.app)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonBody, sendJson, HttpError } from '../http.js';
import { createAuth, MIGRATIONS } from './_connector_auth.js';

const MAIN_PORT = Number(process.env.JAKESDATA_PORT) || 4800;
const PORT = process.env.JAKESDATA_CONNECTOR_PORT !== undefined
  ? Number(process.env.JAKESDATA_CONNECTOR_PORT)
  : (process.env.JAKESDATA_PORT ? MAIN_PORT + 1 : 4801);
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const BODY_LIMIT = 1024 * 1024;
const API_TIMEOUT_MS = 20_000;
const HEADERS_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

const INSTRUCTIONS = `Jake's Brain is Jake's personal app (food log, tasks, groceries, notes), running on his own PC.
Food log: whenever Jake says he ate or drank something, log it with food_log. Estimate calories and protein/carbs/fat in grams when he doesn't give them, and put how you estimated in notes (e.g. "Chopt published nutrition" or "Estimate: bread ~430 + ham ~120"). meal is breakfast, lunch, dinner or snack. date is Jake's local date (YYYY-MM-DD) and defaults to today on his PC; use yesterday's date when he is catching up on yesterday. Before estimating, food_search for the food: he eats the same things often (e.g. his protein shake, 4 eggs, PB toast) and should get the same numbers each time. Log each item as its own entry. After logging, tell him the day's totals from the reply.`;

let auth = null;
let listening = false;
let lastCall = null;

export default {
  id: 'connector',
  migrations: MIGRATIONS,
  register(r, ctx) {
    auth = createAuth({ db: ctx.db, settings: ctx.settings, dataDir: ctx.dataDir, log: ctx.log, port: PORT });
    fs.rmSync(path.join(ctx.dataDir, 'connector', 'secret'), { force: true }); // the old URL secret

    const info = () => {
      const publicUrl = String(ctx.settings.get('connector.publicUrl', '') || '').replace(/\/+$/, '');
      return { port: PORT, publicUrl, url: publicUrl ? `${publicUrl}/mcp` : null, listening, lastCall, ...auth.status() };
    };
    r.get('/api/connector', () => info());
    r.put('/api/connector/password', async (req) => {
      await auth.setPassword((await readJsonBody(req)).password);
      return info();
    });
    r.delete('/api/connector/sessions', () => {
      auth.signOutAll();
      ctx.log.info('connector: signed everything out');
      return info();
    });

    if (!PORT) {
      ctx.log.info('connector off (JAKESDATA_CONNECTOR_PORT=0)');
      return;
    }
    const server = http.createServer((req, res) => {
      handle(req, res, ctx).catch((err) => {
        ctx.log.error('connector request failed:', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
        else res.destroy();
      });
    });
    server.on('error', (err) => {
      listening = false;
      ctx.log.error(`connector cannot listen on 127.0.0.1:${PORT}: ${err.message}`);
    });
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.listen(PORT, '127.0.0.1', () => {
      listening = true;
      ctx.log.info(`connector listening on http://127.0.0.1:${PORT}/mcp`);
    });
    server.unref();
  },
};

// ---------------------------------------------------------------- HTTP

async function handle(req, res, ctx) {
  const t0 = performance.now();
  const url = new URL(req.url, 'http://localhost');
  // The path only: a query string can carry an authorization code.
  res.on('close', () => console.log(`[connector] ${req.method} ${url.pathname.slice(0, 60)} ${res.statusCode} ${Math.round(performance.now() - t0)}ms`));
  if (await auth.route(req, res, url)) return;
  if (url.pathname !== '/mcp') return sendJson(res, 404, { error: 'not found' });
  if (!auth.verify(req)) {
    const bad = req.headers.authorization ? ', error="invalid_token"' : '';
    return sendJson(res, 401, { error: 'sign-in required' }, {
      'WWW-Authenticate': `Bearer resource_metadata="${auth.resourceMetadataUrl()}"${bad}`,
    });
  }
  if (req.method !== 'POST') {
    // Stateless server: no server-to-client SSE stream, no sessions to delete.
    return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
  }

  let msg;
  try {
    msg = await readJsonBody(req, { limit: BODY_LIMIT });
  } catch (err) {
    return sendJson(res, 400, rpcError(null, -32700, err instanceof HttpError ? err.message : 'parse error'));
  }
  const batch = Array.isArray(msg);
  const messages = batch ? msg : [msg];
  const replies = [];
  for (const one of messages) {
    const reply = await dispatch(one, ctx);
    if (reply) replies.push(reply);
  }
  if (!replies.length) {
    res.writeHead(202);
    return res.end();
  }
  sendJson(res, 200, batch ? replies : replies[0]);
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function dispatch(msg, ctx) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return rpcError(msg && msg.id, -32600, 'invalid request');
  const isRequest = msg.id !== undefined && msg.id !== null && typeof msg.method === 'string';
  if (!isRequest) return null; // notifications (initialized, cancelled) and stray responses
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  const result = (value) => ({ jsonrpc: '2.0', id, result: value });

  switch (method) {
    case 'initialize': {
      const asked = String(params.protocolVersion || '');
      return result({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'jakes-brain', title: "Jake's Brain", version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({
        tools: TOOLS.map((t) => ({
          name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
          annotations: { readOnlyHint: Boolean(t.readOnly), destructiveHint: Boolean(t.destructive), openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${params.name}`);
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      lastCall = { tool: tool.name, at: new Date().toISOString() };
      try {
        const out = await tool.run(args);
        return result({ content: [{ type: 'text', text: JSON.stringify(out) }], isError: false });
      } catch (err) {
        const message = err instanceof ApiFail ? err.message : `failed: ${err && err.message ? err.message : err}`;
        if (!(err instanceof ApiFail)) ctx.log.error(`tool ${tool.name} failed:`, err);
        return result({ content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

// ---------------------------------------------------------------- loopback API

class ApiFail extends Error {}

async function api(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${MAIN_PORT}${p}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (res.status === 204) return { ok: true };
  let data = null;
  try {
    data = await res.json();
  } catch { /* not JSON */ }
  if (!res.ok) throw new ApiFail(`${res.status}: ${(data && data.error) || res.statusText}`);
  return data;
}

const q = (obj) => {
  const s = new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return s ? `?${s}` : '';
};
const enc = encodeURIComponent;
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

// ---------------------------------------------------------------- tools

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: "Jake's local date, YYYY-MM-DD. Omit for today." };
const MEAL = { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] };
const GRAMS = (what) => ({ type: 'number', minimum: 0, description: `${what} in grams` });
const ENTRY_FIELDS = {
  name: { type: 'string', description: 'What was eaten, specific, with the amount: "4 eggs", "Chopt Harvest Bowl w/ double chicken"' },
  meal: MEAL,
  calories: { type: 'number', minimum: 0, description: 'kcal' },
  protein: GRAMS('Protein'),
  carbs: GRAMS('Carbs'),
  fat: GRAMS('Fat'),
  notes: { type: 'string', description: 'How the numbers were estimated or where they came from' },
  date: DATE,
};
const ENTRY_KEYS = ['name', 'meal', 'calories', 'protein', 'carbs', 'fat', 'notes', 'date', 'ext_id'];

const TOOLS = [
  {
    name: 'food_log',
    title: 'Log food',
    description: 'Add one or more things Jake ate or drank to his food log. Returns what was added and the totals for each day touched.',
    inputSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array', minItems: 1, maxItems: 500,
          items: {
            type: 'object',
            properties: { ...ENTRY_FIELDS, ext_id: { type: 'string', description: 'Only for imports: a stable source id (e.g. the Notion page URL) so re-running the import skips rows already added' } },
            required: ['name', 'meal', 'calories'],
          },
        },
      },
      required: ['entries'],
    },
    async run({ entries }) {
      if (!Array.isArray(entries) || !entries.length) throw new ApiFail('entries must be a non-empty array');
      const out = await api('POST', '/api/food/entries', { entries: entries.map((e) => pick(e || {}, ENTRY_KEYS)) });
      const dates = [...new Set(out.entries.map((e) => e.date))].sort();
      const totals = {};
      if (dates.length <= 7) for (const d of dates) totals[d] = (await api('GET', `/api/food/day/${d}`)).totals;
      return { added: out.entries, skipped_already_imported: out.skipped, day_totals: totals };
    },
  },
  {
    name: 'food_day',
    title: 'Food for a day',
    description: "Everything Jake logged on one day, with the day's calorie and macro totals and his goals.",
    readOnly: true,
    inputSchema: { type: 'object', properties: { date: DATE } },
    run: ({ date }) => api('GET', `/api/food/day/${date ? enc(date) : 'today'}`),
  },
  {
    name: 'food_history',
    title: 'Daily totals',
    description: 'Calories, protein, carbs and fat per day over a date range (default the last 30 days). Days with nothing logged are left out.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { from: { ...DATE, description: 'First day, YYYY-MM-DD' }, to: { ...DATE, description: 'Last day, YYYY-MM-DD (default today)' } } },
    run: ({ from, to }) => api('GET', `/api/food/days${q({ from, to })}`),
  },
  {
    name: 'food_search',
    title: 'Search past food',
    description: 'Find past entries by name (e.g. "protein shake", "chopt") to reuse the same calories and macros Jake had before.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: ({ query }) => api('GET', `/api/food/search${q({ q: query })}`),
  },
  {
    name: 'food_update',
    title: 'Fix a food entry',
    description: 'Change an entry (find its id with food_day or food_search). Send only the fields to change.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' }, ...ENTRY_FIELDS }, required: ['id'] },
    run: (args) => api('PATCH', `/api/food/entries/${enc(args.id)}`, pick(args, ENTRY_KEYS.filter((k) => k !== 'ext_id'))),
  },
  {
    name: 'food_delete',
    title: 'Delete a food entry',
    description: 'Remove an entry from the food log by id.',
    destructive: true,
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    run: ({ id }) => api('DELETE', `/api/food/entries/${enc(id)}`),
  },
  {
    name: 'food_goals',
    title: 'Daily food goals',
    description: 'Read Jake\'s daily goals, or set them by passing any of calories / protein / carbs / fat (null clears one).',
    inputSchema: {
      type: 'object',
      properties: {
        calories: { type: ['number', 'null'], minimum: 0 }, protein: { type: ['number', 'null'], minimum: 0 },
        carbs: { type: ['number', 'null'], minimum: 0 }, fat: { type: ['number', 'null'], minimum: 0 },
      },
    },
    run: (args) => {
      const patch = pick(args, ['calories', 'protein', 'carbs', 'fat']);
      return Object.keys(patch).length ? api('PUT', '/api/food/goals', patch) : api('GET', '/api/food/goals');
    },
  },
  {
    name: 'tasks_list',
    title: 'List tasks',
    description: "Jake's task checklist (open first, then done).",
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    run: () => api('GET', '/api/tasks'),
  },
  {
    name: 'tasks_add',
    title: 'Add a task',
    description: 'Add a task to Jake\'s checklist.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: ({ text }) => api('POST', '/api/tasks', { text }),
  },
  {
    name: 'tasks_set_done',
    title: 'Check off a task',
    description: 'Mark a task done (or not done) by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' }, done: { type: 'boolean', default: true } }, required: ['id'] },
    run: ({ id, done = true }) => api('PATCH', `/api/tasks/${enc(id)}`, { done }),
  },
  {
    name: 'grocery_list',
    title: 'Grocery list',
    description: 'What is on Jake\'s grocery list, grouped by aisle.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    run: () => api('GET', '/api/grocery'),
  },
  {
    name: 'grocery_add',
    title: 'Add groceries',
    description: 'Add items to Jake\'s grocery list (the aisle is filled in automatically).',
    inputSchema: {
      type: 'object',
      properties: { items: { type: 'array', minItems: 1, items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'string' } }, required: ['name'] } } },
      required: ['items'],
    },
    async run({ items }) {
      if (!Array.isArray(items) || !items.length) throw new ApiFail('items must be a non-empty array');
      const added = [];
      for (const it of items) added.push((await api('POST', '/api/grocery', pick(it || {}, ['name', 'qty']))).item);
      return { added };
    },
  },
  {
    name: 'notes_search',
    title: 'Search notes',
    description: "Search Jake's notes by text (title and body).",
    readOnly: true,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    run: ({ query }) => api('GET', `/api/notes${q({ q: query })}`),
  },
  {
    name: 'notes_create',
    title: 'Create a note',
    description: 'Create a note in Jake\'s Notes app.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } },
    run: (args) => api('POST', '/api/notes', pick(args, ['title', 'body'])),
  },
];

