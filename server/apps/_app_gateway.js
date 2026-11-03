import http from 'node:http';
import { pipeline } from 'node:stream';
import { HttpError, readJsonBody, readRawBody, sendJson } from '../http.js';

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const APP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const REQUEST_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'content-length', 'range',
  'if-range', 'if-none-match', 'if-modified-since', 'x-filename']);
const RESPONSE_HEADERS = new Set(['content-type', 'content-length', 'content-range', 'accept-ranges',
  'content-disposition', 'etag', 'last-modified', 'retry-after', 'allow', 'content-security-policy',
  'content-security-policy-report-only', 'permissions-policy', 'cross-origin-resource-policy',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy']);
const esc = (value) => String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

export function parseGatewayUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 16384 || !raw.startsWith('/') || raw.startsWith('//')
    || /[\\#\u0000-\u0020\u007f]/.test(raw)) throw new HttpError(400, 'Invalid request path.');
  const pathname = raw.split('?')[0];
  let segments;
  try { segments = pathname.split('/').map(decodeURIComponent); }
  catch { throw new HttpError(400, 'Invalid request path.'); }
  if (pathname.includes('//') || segments.some((segment) => segment === '.' || segment === '..'
    || /[/\\\u0000-\u001f\u007f]/.test(segment) || /%[a-f0-9]{2}/i.test(segment))) {
    throw new HttpError(400, 'Invalid request path.');
  }
  return new URL(raw, 'http://localhost');
}

function canonicalOrigin(auth) {
  let origin;
  try { origin = new URL(auth.publicOrigin()); }
  catch { throw new HttpError(503, 'The public app address is not configured.'); }
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/'
    || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new HttpError(503, 'The public app address is not configured.');
  }
  return origin;
}

function requireHost(req, origin) {
  const host = req.headers.host;
  if (typeof host !== 'string' || /[\s/@\\?#]/.test(host)) throw new HttpError(421, 'Wrong app address.');
  let supplied;
  try { supplied = new URL(`${origin.protocol}//${host}`); }
  catch { throw new HttpError(421, 'Wrong app address.'); }
  if (supplied.origin !== origin.origin) throw new HttpError(421, 'Wrong app address.');
}

function requireOrigin(req, origin) {
  if (req.headers.origin !== origin.origin || req.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'Open the app and try again.');
  }
}

export function requireLocalPairingRequest(req, mainPort) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    || req.headers['x-jakes-brain-pairing'] !== 'local-owner'
    || String(req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') {
    throw new HttpError(403, 'Pair devices from the PC.');
  }
  const allowed = [`http://127.0.0.1:${mainPort}`, `http://localhost:${mainPort}`, `http://[::1]:${mainPort}`];
  const origin = `http://${req.headers.host}`;
  if (!allowed.includes(origin) || req.headers.origin && req.headers.origin !== origin
    || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Pair devices from the PC.');
}

function nextPath(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')
    || /[\\\u0000-\u0020\u007f]/.test(value) || /^\/app-(?:login|pair|logout)(?:[/?#]|$)/.test(value)) return '/';
  try {
    const parsed = new URL(value, 'https://app.invalid');
    return parsed.origin === 'https://app.invalid' ? parsed.pathname + parsed.search + parsed.hash : '/';
  } catch { return '/'; }
}

function signInPage(res, next, error = '', status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Jake's Brain</title><style>
:root{color-scheme:light dark;--bg:#f2f2f7;--card:#fff;--text:#1c1c1e;--muted:#6e6e73;--line:#d1d1d6;--error:#c62828}@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--text:#f5f5f7;--muted:#98989d;--line:#38383a;--error:#ff6961}}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:100%;max-width:380px;padding:28px;background:var(--card);border-radius:20px}h1{font-size:25px;letter-spacing:-.6px;margin:0 0 8px}p{color:var(--muted);margin:0 0 24px}label{display:block;margin-bottom:8px;font-weight:600}input,button{width:100%;min-height:48px;font:inherit;border-radius:12px;padding:12px}input{background:transparent;color:inherit;border:1px solid var(--line)}button{margin-top:16px;border:0;background:var(--text);color:var(--card);font-weight:600}.error{color:var(--error)}</style></head><body><main><h1>Jake's Brain</h1><p>Sign in to your apps.</p>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}<form method="post" action="/app-login"><input type="hidden" name="next" value="${esc(next)}"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="200" required autofocus><button type="submit">Sign in</button></form></main></body></html>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(html);
}

function redirect(res, destination, cookie) {
  res.writeHead(303, { Location: destination, 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) });
  res.end();
}

function proxy(req, res, mainPort, body) {
  return new Promise((resolve) => {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (REQUEST_HEADERS.has(name)) headers[name] = value;
    headers.host = `127.0.0.1:${mainPort}`;
    if (body) headers['content-length'] = body.length;
    if (req.headers.origin) headers.origin = `http://127.0.0.1:${mainPort}`;
    const upstream = http.request({ hostname: '127.0.0.1', port: mainPort, path: req.url,
      method: req.method, headers }, (response) => {
      const outgoing = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };
      for (const [name, value] of Object.entries(response.headers)) if (RESPONSE_HEADERS.has(name)) outgoing[name] = value;
      res.writeHead(response.statusCode || 502, outgoing);
      pipeline(response, res, () => { upstream.destroy(); resolve(); });
    });
    upstream.setTimeout(120000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => {
      if (!res.headersSent && !res.destroyed) sendJson(res, 502, { error: 'The PC app is unavailable. Try again shortly.' });
      else if (!res.writableEnded) res.destroy();
      req.unpipe(upstream);
      req.resume();
      resolve();
    });
    req.on('aborted', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    if (body) upstream.end(body);
    else req.pipe(upstream);
  });
}

export function createAppGateway({ auth, mainPort }) {
  return async function appGateway(req, res, url = parseGatewayUrl(req.url)) {
    const origin = canonicalOrigin(auth);
    requireHost(req, origin);
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (url.pathname === '/api/health' && SAFE_METHODS.has(req.method)) {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (!APP_METHODS.has(req.method)) throw new HttpError(405, 'Method not allowed.');
    if (req.headers.origin && req.headers.origin !== origin.origin) throw new HttpError(403, 'Open the app and try again.');
    if (!SAFE_METHODS.has(req.method)) requireOrigin(req, origin);
    const decodedPath = decodeURIComponent(url.pathname);
    if (/^\/api\/connector(?:\/|$)/.test(decodedPath)) throw new HttpError(404, 'Not found.');
    if (url.pathname === '/app-login') {
      if (req.method === 'GET') {
        const next = nextPath(url.searchParams.get('next'));
        if (auth.verifyAppSession(req)) redirect(res, next);
        else signInPage(res, next);
        return;
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      if (String(req.headers['content-type'] || '').split(';')[0].trim() !== 'application/x-www-form-urlencoded') {
        throw new HttpError(415, 'Use the sign-in form.');
      }
      const form = new URLSearchParams((await readRawBody(req, { limit: 4096, idleMs: 10000 })).toString('utf8'));
      const next = nextPath(form.get('next'));
      try {
        if (!(await auth.tryPassword(form.get('password')))) {
          signInPage(res, next, 'Wrong password.', 401);
          return;
        }
        redirect(res, next, auth.issueAppSession());
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        signInPage(res, next, error.message, error.status);
      }
      return;
    }
    if (url.pathname === '/app-pair') {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      if (String(req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'Send JSON.');
      const body = await readJsonBody(req, { limit: 4096, idleMs: 10000 });
      if (!auth.redeemAppPairing(body.token)) throw new HttpError(401, 'This device pairing expired. Pair it again from the PC.');
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.issueAppSession() });
      return;
    }
    if (url.pathname === '/app-logout') {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      redirect(res, '/app-login', auth.signOutApp(req));
      return;
    }
    if (!auth.verifyAppSession(req)) {
      if (req.method === 'GET' && (url.pathname === '/' || String(req.headers.accept || '').includes('text/html') && !/^\/(?:api|media|cache)(?:\/|$)/.test(decodedPath))) {
        redirect(res, `/app-login?next=${encodeURIComponent(nextPath(req.url))}`);
      } else sendJson(res, 401, { error: 'Sign in to Jake\'s Brain.' }, { 'X-JakesData-Sign-In': '/app-login' });
      return;
    }
    let body;
    if (decodedPath.replace(/\/+$/, '') === '/api/settings' && req.method === 'PATCH') {
      const settings = await readJsonBody(req);
      if (Object.keys(settings).some((key) => key.startsWith('connector.'))) throw new HttpError(403, 'Manage sign-in settings on the PC.');
      body = Buffer.from(JSON.stringify(settings));
    }
    await proxy(req, res, mainPort, body);
  };
}
