// Tiny router: register(method, pattern, handler) with ':param' segments and a trailing '*'
// wildcard, query parsing, 404/405 JSON. Handlers get (req, res, ctx) with
//   ctx = { params, query /* plain object, first value per key */, url /* WHATWG URL */, method }
// and may either write the response themselves (sendJson/sendFile) or RETURN a value, which
// is sent as 200 JSON. A thrown HttpError becomes { error } with its status; a busy SQLite
// lock becomes 503; anything else is logged and becomes a 500. HEAD is served by GET routes.
//
//   r.get('/api/tasks', () => ({ tasks: repo.list() }));
//   r.patch('/api/tasks/:id', async (req, res, { params }) => { const body = await readJsonBody(req); ... });
import { HttpError, sendJson, sendError } from './http.js';
import { isDbBusy } from './db.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function createRouter({ log = console } = {}) {
  const routes = [];

  function register(method, pattern, handler) {
    const verb = String(method || '').toUpperCase();
    if (!METHODS.includes(verb)) throw new TypeError(`router: unknown method ${method}`);
    if (typeof pattern !== 'string' || !pattern.startsWith('/')) throw new TypeError(`router: pattern must start with "/" (${pattern})`);
    if (typeof handler !== 'function') throw new TypeError(`router: handler for ${verb} ${pattern} must be a function`);
    const segments = pattern.replace(/\/+$/, '').split('/').slice(1).map((seg, i, arr) => {
      if (seg === '*' && i === arr.length - 1) return { kind: 'rest' };
      if (seg.startsWith(':') && seg.length > 1) return { kind: 'param', name: seg.slice(1) };
      return { kind: 'literal', value: seg };
    });
    const literals = segments.filter((s) => s.kind === 'literal').length;
    routes.push({ method: verb, pattern, segments, literals, handler });
    return api;
  }

  function match(route, parts) {
    const segs = route.segments;
    const params = {};
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.kind === 'rest') {
        const rest = parts.slice(i);
        if (!rest.length) return null;
        params.rest = rest.join('/');
        return params;
      }
      if (i >= parts.length) return null;
      if (seg.kind === 'literal') {
        if (seg.value !== parts[i]) return null;
      } else {
        params[seg.name] = parts[i];
      }
    }
    return parts.length === segs.length ? params : null;
  }

  // Returns true when the request was answered (including 405), false when no route matched.
  async function handle(req, res, url) {
    const method = req.method === 'HEAD' ? 'GET' : String(req.method).toUpperCase();
    let parts;
    try {
      parts = url.pathname.replace(/\/+$/, '').split('/').slice(1).map((p) => decodeURIComponent(p));
    } catch {
      sendError(res, 400, 'bad path');
      return true;
    }
    if (parts.some((p) => p.includes('\0'))) {
      sendError(res, 400, 'bad path');
      return true;
    }

    let best = null;
    const allowed = new Set();
    for (const route of routes) {
      const params = match(route, parts);
      if (!params) continue;
      allowed.add(route.method);
      if (route.method !== method) continue;
      if (!best || route.literals > best.route.literals) best = { route, params };
    }
    if (!best) {
      if (allowed.size) {
        const allow = [...allowed].flatMap((m) => (m === 'GET' ? ['GET', 'HEAD'] : [m])).join(', ');
        sendError(res, 405, 'method not allowed', { Allow: allow });
        return true;
      }
      return false;
    }

    const query = {};
    for (const [key, value] of url.searchParams) if (!(key in query)) query[key] = value;
    const ctx = { params: best.params, query, url, method: req.method };
    try {
      const result = await best.route.handler(req, res, ctx);
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
      else if (result === undefined && !res.headersSent && !res.writableEnded) {
        // A handler that neither wrote nor returned: answer 204 rather than hang the client.
        res.writeHead(204, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        res.end();
      }
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendError(res, err.status, err.message, err.headers);
        else res.destroy();
        return true;
      }
      if (isDbBusy(err)) {
        log.error(`[jakes-data] ${req.method} ${req.url}: database is busy (${err.message})`);
        if (!res.headersSent) sendError(res, 503, 'database is busy, try again', { 'Retry-After': '1' });
        else res.destroy();
        return true;
      }
      log.error(`[jakes-data] ${req.method} ${req.url} failed:`, err);
      if (!res.headersSent) sendError(res, 500, 'internal error');
      else res.destroy();
    }
    return true;
  }

  const api = {
    register,
    get: (pattern, handler) => register('GET', pattern, handler),
    post: (pattern, handler) => register('POST', pattern, handler),
    put: (pattern, handler) => register('PUT', pattern, handler),
    patch: (pattern, handler) => register('PATCH', pattern, handler),
    delete: (pattern, handler) => register('DELETE', pattern, handler),
    handle,
    routes: () => routes.map((r) => `${r.method} ${r.pattern}`),
  };
  return api;
}
