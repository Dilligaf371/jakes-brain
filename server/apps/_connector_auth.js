// Sign-in for the Claude connector: a small OAuth 2.1 authorization server, the same flow Notion's
// connector uses. Claude (or Claude Code) sends Jake to /authorize, he types his password on a page
// served here, and Claude gets a one-hour access token plus a refresh token. The address itself
// holds no secret: POST /mcp without a valid token is a 401.
//
// - Password: scrypt hash in DATA/connector/password (mode 600), set from Settings on the private
//   app, never from the public side. Five wrong tries lock sign-in for 15 minutes, doubling up to
//   24 hours; setting the password clears the lock.
// - Tokens are stored as SHA-256 hashes. Access tokens last an hour, refresh tokens 90 days and are
//   replaced on every use; a refresh token replayed after REFRESH_GRACE_MS ends that sign-in.
// - PKCE S256 is required, codes are single use, and redirect addresses are limited to Claude's
//   callback and loopback (Claude Code), so a look-alike client can't receive a code.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
//   GET  /.well-known/oauth-authorization-server       RFC 8414
//   POST /register                                     RFC 7591
//   GET  /authorize, POST /authorize                   the sign-in page
//   POST /token                                        authorization_code, refresh_token
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readRawBody, sendJson, HttpError } from '../http.js';

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const REFRESH_GRACE_MS = 60 * 1000; // a retry after a lost reply is not an attack
const CODE_TTL_MS = 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;
const LOCK_BASE_MS = 15 * 60 * 1000;
const LOCK_MAX_MS = 24 * 60 * 60 * 1000;
const MAX_CLIENTS = 100;
const MAX_REQUESTS = 100;
const BODY_LIMIT = 16 * 1024;
const NAME_MAX = 100;
export const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;
const SCOPE = 'brain';
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const APP_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const APP_PAIR_TTL_MS = 10 * 60 * 1000;
export const APP_COOKIE = '__Host-jakesbrain';
const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export const MIGRATIONS = [
  {
    id: 'connector-1',
    sql: `
      CREATE TABLE IF NOT EXISTS connector_clients (
        client_id     TEXT PRIMARY KEY,
        secret_hash   TEXT,
        name          TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        last_used_at  INTEGER
      );
      CREATE TABLE IF NOT EXISTS connector_tokens (
        hash       TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        client_id  TEXT NOT NULL,
        family     TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at    INTEGER
      );
      CREATE INDEX IF NOT EXISTS connector_tokens_family ON connector_tokens (family);
    `,
  },
  {
    id: 'connector-2',
    sql: `
      CREATE TABLE IF NOT EXISTS connector_app_sessions (
        hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connector_app_pairings (
        hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
      );
    `,
  },
];

const randomToken = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sameText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const scrypt = (password, salt, options) => new Promise((resolve, reject) => {
  crypto.scrypt(password.normalize('NFKC'), salt, 32, options, (err, key) => (err ? reject(err) : resolve(key)));
});
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function redirectAllowed(uri) {
  if (typeof uri !== 'string' || uri.length > 500) return false;
  if (CLAUDE_CALLBACKS.includes(uri)) return true;
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  return u.protocol === 'http:' && LOOPBACK_HOSTS.includes(u.hostname) && !u.username && !u.password && !u.hash;
}

class OAuthError extends Error {
  constructor(status, code, description) {
    super(description);
    this.status = status;
    this.code = code;
  }
}

export function createAuth({ db, settings, dataDir, log, port }) {
  const passwordFile = path.join(dataDir, 'connector', 'password');
  const requests = new Map(); // id -> a sign-in waiting for the password
  const codes = new Map();    // sha256(code) -> what the code was issued for
  let fails = 0;
  let locks = 0;
  let lockedUntil = 0;
  let passwordWork = false;
  let credentialRevision = 0;

  const getClient = db.prepare('SELECT * FROM connector_clients WHERE client_id = ?');
  const addClient = db.prepare(`INSERT INTO connector_clients (client_id, secret_hash, name, redirect_uris, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  const countClients = db.prepare('SELECT COUNT(*) AS n FROM connector_clients');
  const evictClient = db.prepare(`DELETE FROM connector_clients WHERE client_id = (
    SELECT client_id FROM connector_clients c
    WHERE NOT EXISTS (SELECT 1 FROM connector_tokens t WHERE t.client_id = c.client_id)
    ORDER BY created_at LIMIT 1)`);
  const touchClient = db.prepare('UPDATE connector_clients SET last_used_at = ? WHERE client_id = ?');
  const getToken = db.prepare('SELECT * FROM connector_tokens WHERE hash = ?');
  const addToken = db.prepare(`INSERT INTO connector_tokens (hash, kind, client_id, family, expires_at)
    VALUES (?, ?, ?, ?, ?)`);
  const spendToken = db.prepare('UPDATE connector_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL');
  const pruneTokens = db.prepare('DELETE FROM connector_tokens WHERE expires_at < ?');
  const dropFamily = db.prepare('DELETE FROM connector_tokens WHERE family = ?');
  const clearTokens = db.prepare('DELETE FROM connector_tokens');
  const getAppSession = db.prepare('SELECT * FROM connector_app_sessions WHERE hash = ?');
  const addAppSession = db.prepare('INSERT INTO connector_app_sessions (hash, created_at, expires_at) VALUES (?, ?, ?)');
  const dropAppSession = db.prepare('DELETE FROM connector_app_sessions WHERE hash = ?');
  const pruneAppSessions = db.prepare('DELETE FROM connector_app_sessions WHERE expires_at <= ?');
  const clearAppSessions = db.prepare('DELETE FROM connector_app_sessions');
  const addPairing = db.prepare('INSERT INTO connector_app_pairings (hash, expires_at) VALUES (?, ?)');
  const consumePairing = db.prepare('DELETE FROM connector_app_pairings WHERE hash = ? AND expires_at > ? RETURNING hash');
  const clearPairings = db.prepare('DELETE FROM connector_app_pairings');
  const signedIn = db.prepare(`SELECT c.name, c.last_used_at AS lastUsed FROM connector_clients c
    WHERE EXISTS (SELECT 1 FROM connector_tokens t
      WHERE t.client_id = c.client_id AND t.kind = 'refresh' AND t.used_at IS NULL AND t.expires_at > ?)
    ORDER BY c.last_used_at DESC`);

  const base = () => String(settings.get('connector.publicUrl', '') || '').replace(/\/+$/, '') || `http://127.0.0.1:${port}`;
  const resource = () => `${base()}/mcp`;
  const resourceOk = (value) => !value || [resource(), base(), `${base()}/`].includes(value);
  const resourceMetadataUrl = () => `${base()}/.well-known/oauth-protected-resource`;

  // ---------------------------------------------------------------- password

  function readPassword() {
    try {
      return JSON.parse(fs.readFileSync(passwordFile, 'utf8'));
    } catch {
      return null;
    }
  }

  async function setPassword(password) {
    if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      throw new HttpError(400, `password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`);
    }
    if (passwordWork) throw new HttpError(429, 'Sign-in is busy. Try again in a moment.');
    passwordWork = true;
    const salt = crypto.randomBytes(16);
    let key;
    try { key = await scrypt(password, salt, SCRYPT); }
    finally { passwordWork = false; }
    fs.mkdirSync(path.dirname(passwordFile), { recursive: true, mode: 0o700 });
    const next = `${passwordFile}.tmp`;
    fs.writeFileSync(next, JSON.stringify({
      salt: salt.toString('base64'), hash: key.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    }), { mode: 0o600 });
    fs.renameSync(next, passwordFile);
    fails = 0;
    locks = 0;
    lockedUntil = 0;
    signOutAll();
    log.info('connector password set');
  }

  // Counts the try BEFORE the slow hash, so a burst of parallel guesses can't outrun the lock.
  async function tryPassword(password) {
    if (lockedUntil > Date.now()) throw new HttpError(429, 'Too many wrong passwords. Try again later.');
    if (passwordWork) throw new HttpError(429, 'Sign-in is busy. Try again in a moment.');
    const stored = readPassword();
    if (!stored || typeof password !== 'string' || password.length > PASSWORD_MAX) return false;
    passwordWork = true;
    const revision = credentialRevision;
    fails += 1;
    if (fails >= MAX_TRIES) {
      fails = 0;
      locks += 1;
      lockedUntil = Date.now() + Math.min(LOCK_BASE_MS * 2 ** (locks - 1), LOCK_MAX_MS);
      log.info(`connector sign-in locked for ${Math.round((lockedUntil - Date.now()) / 60000)} min after wrong passwords`);
    }
    let key;
    try {
      key = await scrypt(password, Buffer.from(stored.salt, 'base64'), {
        N: stored.N, r: stored.r, p: stored.p, maxmem: SCRYPT.maxmem,
      });
    } finally { passwordWork = false; }
    if (revision !== credentialRevision) return false;
    if (!crypto.timingSafeEqual(key, Buffer.from(stored.hash, 'base64'))) return false;
    fails = 0;
    locks = 0;
    lockedUntil = 0;
    return true;
  }

  // ---------------------------------------------------------------- tokens

  function issueTokens(clientId, family) {
    const now = Date.now();
    const access = randomToken();
    const refresh = randomToken();
    pruneTokens.run(now);
    addToken.run(sha256(access), 'access', clientId, family, now + ACCESS_TTL_MS);
    addToken.run(sha256(refresh), 'refresh', clientId, family, now + REFRESH_TTL_MS);
    touchClient.run(now, clientId);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: SCOPE };
  }

  function verify(req) {
    const m = /^Bearer ([\w-]{20,})$/i.exec(req.headers.authorization || '');
    if (!m) return false;
    const row = getToken.get(sha256(m[1]));
    if (!row || row.kind !== 'access' || row.expires_at <= Date.now()) return false;
    touchClient.run(Date.now(), row.client_id);
    return true;
  }

  // Registered clients stay: Claude keeps its client_id, so it can come back to the sign-in page.
  function signOutAll() {
    credentialRevision += 1;
    clearTokens.run();
    clearAppSessions.run();
    clearPairings.run();
    requests.clear();
    codes.clear();
  }

  function appCookieToken(req) {
    const matches = String(req.headers.cookie || '').split(';').map((entry) => entry.trim())
      .filter((entry) => entry.startsWith(`${APP_COOKIE}=`));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(APP_COOKIE.length + 1);
    return /^[\w-]{43}$/.test(token) ? token : null;
  }

  function verifyAppSession(req) {
    const token = appCookieToken(req);
    const row = token && getAppSession.get(sha256(token));
    return row && row.expires_at > Date.now() ? row : null;
  }

  function issueAppSession() {
    const now = Date.now();
    pruneAppSessions.run(now);
    const count = db.prepare('SELECT COUNT(*) AS count FROM connector_app_sessions').get().count;
    if (count >= 100) throw new HttpError(429, 'Too many signed-in devices. Sign out other devices first.');
    const token = randomToken();
    addAppSession.run(sha256(token), now, now + APP_SESSION_TTL_MS);
    return `${APP_COOKIE}=${token}; Path=/; Max-Age=${APP_SESSION_TTL_MS / 1000}; Secure; HttpOnly; SameSite=Lax`;
  }

  function signOutApp(req) {
    const token = appCookieToken(req);
    if (token) dropAppSession.run(sha256(token));
    return `${APP_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
  }

  function createAppPairing() {
    if (!readPassword()) throw new HttpError(409, 'Set the app password before pairing a device.');
    const token = randomToken();
    const expiresAt = Date.now() + APP_PAIR_TTL_MS;
    clearPairings.run();
    addPairing.run(sha256(token), expiresAt);
    return { token, expiresAt: new Date(expiresAt).toISOString(), url: base(), redeemPath: '/app-pair' };
  }

  function redeemAppPairing(token) {
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return false;
    return Boolean(consumePairing.get(sha256(token), Date.now()));
  }

  function status() {
    return {
      passwordSet: Boolean(readPassword()),
      passwordMin: PASSWORD_MIN,
      lockedUntil: lockedUntil > Date.now() ? new Date(lockedUntil).toISOString() : null,
      signedIn: signedIn.all(Date.now()).map((c) => ({ name: c.name, lastUsed: c.lastUsed ? new Date(c.lastUsed).toISOString() : null })),
    };
  }

  // ---------------------------------------------------------------- pages

  function page(res, status_, heading, body, redirectUri) {
    const formTargets = ["'self'"];
    if (redirectUri) formTargets.push(new URL(redirectUri).origin); // Chrome applies this to the redirect too
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Jake's Brain</title><style>
:root { color-scheme: light dark; --bg: #f5f5f7; --card: #fff; --text: #1c1c1e; --muted: #6e6e73; --line: #d1d1d6; --accent: #1c1c1e; --on-accent: #fff; --red: #c62828; }
@media (prefers-color-scheme: dark) { :root { --bg: #000; --card: #1c1c1e; --text: #f5f5f7; --muted: #98989d; --line: #38383a; --accent: #f5f5f7; --on-accent: #000; --red: #ff6b5e; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { width: 100%; max-width: 360px; padding: 24px; background: var(--card); border-radius: 14px; }
h1 { margin: 0 0 8px; font-size: 22px; }
p { margin: 0 0 16px; color: var(--muted); }
label { display: block; margin-bottom: 6px; font-weight: 600; }
input[type=password] { width: 100%; padding: 12px; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 10px; }
button { width: 100%; margin-top: 12px; padding: 12px; font: inherit; font-weight: 600; border: 0; border-radius: 10px; background: var(--accent); color: var(--on-accent); cursor: pointer; }
button.quiet { background: transparent; color: var(--muted); font-weight: 400; }
.error { color: var(--red); }
</style></head><body><main><h1>${esc(heading)}</h1>${body}</main></body></html>`;
    res.writeHead(status_, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${formTargets.join(' ')}; frame-ancestors 'none'; base-uri 'none'`,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    res.end(html);
  }

  const minutesLeft = () => Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60000));

  function signInPage(res, request, error, status_ = 200) {
    const target = new URL(request.redirectUri);
    const where = LOOPBACK_HOSTS.includes(target.hostname) ? 'this computer' : target.hostname;
    page(res, status_, "Sign in to Jake's Brain", `
<p>${esc(request.clientName)} wants to read and change your food log, tasks, groceries and notes. You'll go back to ${esc(where)} after signing in.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/authorize">
<input type="hidden" name="request" value="${esc(request.id)}">
<label for="password">Password</label>
<input id="password" type="password" name="password" autocomplete="current-password" maxlength="${PASSWORD_MAX}" required autofocus>
<button type="submit" name="action" value="allow">Sign in</button>
<button class="quiet" type="submit" name="action" value="deny" formnovalidate>Cancel</button>
</form>`, request.redirectUri);
  }

  function backToClient(res, request, params) {
    const target = new URL(request.redirectUri);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    if (request.state !== null) target.searchParams.set('state', request.state);
    target.searchParams.set('iss', base());
    res.writeHead(303, { Location: target.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  }

  // ---------------------------------------------------------------- endpoints

  function protectedResource(res) {
    sendJson(res, 200, { resource: resource(), authorization_servers: [base()], scopes_supported: [SCOPE], bearer_methods_supported: ['header'] });
  }

  function authorizationServer(res) {
    sendJson(res, 200, {
      issuer: base(),
      authorization_endpoint: `${base()}/authorize`,
      token_endpoint: `${base()}/token`,
      registration_endpoint: `${base()}/register`,
      scopes_supported: [SCOPE],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: AUTH_METHODS,
      authorization_response_iss_parameter_supported: true,
    });
  }

  async function register(req, res) {
    let body;
    try {
      body = JSON.parse((await readRawBody(req, { limit: BODY_LIMIT })).toString('utf8'));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new OAuthError(400, 'invalid_client_metadata', 'body must be JSON');
    }
    if (!body || typeof body !== 'object') throw new OAuthError(400, 'invalid_client_metadata', 'body must be an object');
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uris is required');
    if (!uris.every(redirectAllowed)) throw new OAuthError(400, 'invalid_redirect_uri', 'redirect address not allowed');
    const method = body.token_endpoint_auth_method ?? 'client_secret_basic';
    if (!AUTH_METHODS.includes(method)) throw new OAuthError(400, 'invalid_client_metadata', 'unsupported token_endpoint_auth_method');
    const name = String(body.client_name || 'An app').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, NAME_MAX) || 'An app';

    if (countClients.get().n >= MAX_CLIENTS) {
      evictClient.run();
      if (countClients.get().n >= MAX_CLIENTS) throw new OAuthError(429, 'temporarily_unavailable', 'too many registered clients');
    }
    const clientId = randomToken();
    const secret = method === 'none' ? null : randomToken();
    const now = Date.now();
    addClient.run(clientId, secret && sha256(secret), name, JSON.stringify(uris), now);
    sendJson(res, 201, {
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
    });
  }

  function startSignIn(res, url) {
    const q = url.searchParams;
    const client = getClient.get(q.get('client_id') || '');
    const redirectUri = q.get('redirect_uri');
    // Until the client and its redirect address check out, an error stays on this page: redirecting
    // to an address nobody vouched for is how an open redirect starts.
    if (!client || !redirectUri || !JSON.parse(client.redirect_uris).includes(redirectUri)) {
      return page(res, 400, "This link doesn't work", '<p>Go back to Claude and start connecting again.</p>');
    }
    const request = {
      id: randomToken(),
      clientId: client.client_id,
      clientName: client.name,
      redirectUri,
      state: q.get('state'),
      challenge: q.get('code_challenge'),
      expires: Date.now() + REQUEST_TTL_MS,
    };
    if (q.get('response_type') !== 'code') return backToClient(res, request, { error: 'unsupported_response_type' });
    if (q.get('code_challenge_method') !== 'S256' || !/^[\w-]{43}$/.test(request.challenge || '')) {
      return backToClient(res, request, { error: 'invalid_request', error_description: 'PKCE S256 is required' });
    }
    if (!resourceOk(q.get('resource'))) return backToClient(res, request, { error: 'invalid_target' });
    if (!readPassword()) {
      return page(res, 200, 'Set a password first', "<p>Open Jake's Brain, go to Settings → Claude connector and set a password. Then reload this page.</p>");
    }
    for (const [id, old] of requests) if (old.expires <= Date.now()) requests.delete(id);
    while (requests.size >= MAX_REQUESTS) requests.delete(requests.keys().next().value);
    requests.set(request.id, request);
    signInPage(res, request);
  }

  async function finishSignIn(req, res) {
    const form = new URLSearchParams((await readRawBody(req, { limit: BODY_LIMIT })).toString('utf8'));
    const request = requests.get(form.get('request') || '');
    if (!request || request.expires <= Date.now()) {
      return page(res, 400, 'This sign-in expired', '<p>Go back to Claude and start connecting again.</p>');
    }
    if (form.get('action') === 'deny') {
      requests.delete(request.id);
      return backToClient(res, request, { error: 'access_denied' });
    }
    if (lockedUntil > Date.now()) return signInPage(res, request, `Too many wrong passwords. Try again in ${minutesLeft()} min.`, 429);
    if (!(await tryPassword(form.get('password')))) {
      log.info('connector sign-in: wrong password');
      return signInPage(res, request, lockedUntil > Date.now() ? `Too many wrong passwords. Try again in ${minutesLeft()} min.` : 'Wrong password.', 401);
    }
    requests.delete(request.id);
    const code = randomToken();
    for (const [key, old] of codes) if (old.expires <= Date.now()) codes.delete(key);
    codes.set(sha256(code), {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      challenge: request.challenge,
      family: randomToken(),
      expires: Date.now() + CODE_TTL_MS,
      used: false,
    });
    log.info(`connector sign-in: ${request.clientName}`);
    backToClient(res, request, { code });
  }

  function clientFrom(req, form) {
    let id = form.get('client_id');
    let secret = form.get('client_secret');
    const basic = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization || '');
    if (basic) {
      const [user, ...rest] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      try {
        id = decodeURIComponent(user);
        secret = decodeURIComponent(rest.join(':'));
      } catch {
        throw new OAuthError(401, 'invalid_client', 'bad client credentials');
      }
    }
    const client = id ? getClient.get(id) : null;
    if (!client) throw new OAuthError(401, 'invalid_client', 'unknown client');
    if (client.secret_hash && !sameText(sha256(secret || ''), client.secret_hash)) {
      throw new OAuthError(401, 'invalid_client', 'bad client credentials');
    }
    return client;
  }

  function exchangeCode(client, form) {
    const key = sha256(form.get('code') || '');
    const code = codes.get(key);
    if (!code || code.expires <= Date.now() || code.clientId !== client.client_id) {
      throw new OAuthError(400, 'invalid_grant', 'code is invalid or expired');
    }
    if (code.used) {
      dropFamily.run(code.family);
      throw new OAuthError(400, 'invalid_grant', 'code was already used');
    }
    code.used = true;
    if (form.get('redirect_uri') !== code.redirectUri) throw new OAuthError(400, 'invalid_grant', 'redirect_uri does not match');
    if (!resourceOk(form.get('resource'))) throw new OAuthError(400, 'invalid_target', 'unknown resource');
    const verifier = form.get('code_verifier') || '';
    if (!/^[\w.~-]{43,128}$/.test(verifier)) throw new OAuthError(400, 'invalid_grant', 'code_verifier is invalid');
    const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!sameText(computed, code.challenge)) throw new OAuthError(400, 'invalid_grant', 'code_verifier does not match');
    return issueTokens(client.client_id, code.family);
  }

  function exchangeRefresh(client, form) {
    const hash = sha256(form.get('refresh_token') || '');
    const row = getToken.get(hash);
    const now = Date.now();
    if (!row || row.kind !== 'refresh' || row.client_id !== client.client_id || row.expires_at <= now) {
      throw new OAuthError(400, 'invalid_grant', 'refresh token is invalid or expired');
    }
    if (row.used_at && now - row.used_at > REFRESH_GRACE_MS) {
      dropFamily.run(row.family);
      log.info('connector: an old refresh token came back, that sign-in is ended');
      throw new OAuthError(400, 'invalid_grant', 'refresh token was already used');
    }
    spendToken.run(now, hash);
    return issueTokens(client.client_id, row.family);
  }

  async function token(req, res) {
    const form = new URLSearchParams((await readRawBody(req, { limit: BODY_LIMIT })).toString('utf8'));
    const client = clientFrom(req, form);
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') return sendJson(res, 200, exchangeCode(client, form));
    if (grant === 'refresh_token') return sendJson(res, 200, exchangeRefresh(client, form));
    throw new OAuthError(400, 'unsupported_grant_type', 'unsupported grant_type');
  }

  // Answers the sign-in paths. Returns false for anything else.
  async function route(req, res, url) {
    const known = {
      '/.well-known/oauth-protected-resource': { GET: () => protectedResource(res) },
      '/.well-known/oauth-protected-resource/mcp': { GET: () => protectedResource(res) },
      '/.well-known/oauth-authorization-server': { GET: () => authorizationServer(res) },
      '/register': { POST: () => register(req, res) },
      '/authorize': { GET: () => startSignIn(res, url), POST: () => finishSignIn(req, res) },
      '/token': { POST: () => token(req, res) },
    }[url.pathname];
    if (!known) return false;
    const run = known[req.method];
    if (!run) {
      sendJson(res, 405, { error: 'method not allowed' }, { Allow: Object.keys(known).join(', ') });
      return true;
    }
    try {
      await run();
    } catch (err) {
      if (err instanceof OAuthError) sendJson(res, err.status, { error: err.code, error_description: err.message });
      else if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
      else throw err;
    }
    return true;
  }

  return { route, verify, resourceMetadataUrl, setPassword, signOutAll, status, tryPassword,
    verifyAppSession, issueAppSession, signOutApp, createAppPairing, redeemAppPairing, publicOrigin: base };
}
