import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../db.js';
import { createRouter } from '../router.js';
import { readRawBody, sendJson } from '../http.js';
import { createAuth, MIGRATIONS, APP_COOKIE } from '../apps/_connector_auth.js';
import { parseGatewayUrl, requireLocalPairingRequest } from '../apps/_app_gateway.js';

const PUBLIC_ORIGIN = 'https://brain.example';
const PASSWORD = 'Test-only password 93725';
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function request(port, pathname, { method = 'GET', headers = {}, body, publicHost = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, agent: false,
      headers: { ...(publicHost ? { Host: 'brain.example' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('public app gateway protects app traffic while retaining the existing MCP connection', async (suite) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jakes-app-gateway-'));
  const store = openDb(dataDir);
  store.applyMigrations('connector', MIGRATIONS);
  store.settings.patch({ 'connector.publicUrl': PUBLIC_ORIGIN });
  const log = { info() {}, error() {} };
  const adminAuth = createAuth({ ...store, dataDir, log, port: 4801 });
  await adminAuth.setPassword(PASSWORD);
  const router = createRouter({ log });
  const forwarded = [];
  const main = http.createServer(async (req, res) => {
    if (await router.handle(req, res, new URL(req.url, 'http://localhost'))) return;
    forwarded.push({ path: req.url, method: req.method, headers: req.headers });
    if (req.url.startsWith('/api/test')) {
      sendJson(res, 200, { private: true, body: (await readRawBody(req, { limit: 1024 * 1024 })).toString() });
    } else if (req.url === '/media/test.mp4') {
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 1-3/5', 'Content-Length': 3,
        'Accept-Ranges': 'bytes', 'Cache-Control': 'public,max-age=86400', 'Access-Control-Allow-Origin': '*',
        'Set-Cookie': 'unsafe=bad', 'Content-Security-Policy': 'sandbox' });
      res.end('bcd');
    } else if (req.url === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
      setTimeout(() => res.end('data: last\n\n'), 20);
    } else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Private app</h1>'); }
  });
  const mainPort = await listen(main);
  const reserve = http.createServer();
  const publicPort = await listen(reserve);
  await new Promise((resolve) => reserve.close(resolve));
  process.env.JAKESDATA_PORT = String(mainPort);
  process.env.JAKESDATA_CONNECTOR_PORT = String(publicPort);
  const connector = (await import('../apps/connector.js')).default;
  connector.register(router, { ...store, dataDir, log, routes: () => router.routes() });
  await new Promise((resolve) => setImmediate(resolve));
  const call = (pathname, options) => request(publicPort, pathname, options);
  const mutateHeaders = { Origin: PUBLIC_ORIGIN, 'Content-Type': 'application/json' };
  const login = (password = PASSWORD, extra = {}) => call('/app-login', { method: 'POST',
    headers: { Origin: PUBLIC_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded', ...extra },
    body: new URLSearchParams({ password, next: '/#/workout' }).toString() });
  let cookie;
  let mcpToken;
  suite.after(async () => {
    await new Promise((resolve) => main.close(resolve));
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await suite.test('anonymous health is minimal and all private assets, data, media are blocked', async () => {
    assert.deepEqual(JSON.parse((await call('/api/health')).text), { ok: true });
    assert.equal((await call('/')).status, 303);
    const signIn = await call('/app-login');
    assert.equal(signIn.status, 200);
    assert.equal(signIn.headers['referrer-policy'], 'same-origin');
    for (const target of ['/api/test', '/api/settings', '/kit.js', '/apps/workout/index.js', '/media/test.mp4', '/cache/test.jpg']) {
      const response = await call(target);
      assert.equal(response.status, 401, target);
      assert.equal(response.headers['x-jakesdata-sign-in'], '/app-login');
    }
    assert.equal(forwarded.length, 0);
    assert.equal((await call('/api/health', { headers: { Host: 'evil.example' } })).status, 421);
  });

  await suite.test('password login requires the canonical host and origin and issues a hashed persistent cookie', async () => {
    assert.equal((await login(PASSWORD, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await login(PASSWORD, { Host: 'evil.example' })).status, 421);
    assert.equal((await login('incorrect')).status, 401);
    const response = await login();
    assert.equal(response.status, 303);
    assert.equal(response.headers.location, '/#/workout');
    assert.equal(response.headers['referrer-policy'], 'same-origin');
    const fullCookie = response.headers['set-cookie'][0];
    assert.match(fullCookie, /; Secure; HttpOnly; SameSite=Lax$/);
    assert.match(fullCookie, /Max-Age=7776000/);
    cookie = fullCookie.split(';')[0];
    assert.ok(cookie.startsWith(`${APP_COOKIE}=`));
    const token = cookie.split('=')[1];
    const stored = store.db.prepare('SELECT * FROM connector_app_sessions').get();
    assert.equal(stored.hash, digest(token));
    assert.ok(!JSON.stringify(stored).includes(token));
  });

  await suite.test('authenticated proxy handles reads, writes, uploads, ranges and streamed replies without forwarding credentials', async () => {
    const headers = { Cookie: cookie, Authorization: 'Bearer must-not-leak', 'X-Forwarded-Host': 'evil.example' };
    assert.equal((await call('/api/test', { headers })).status, 200);
    const payload = 'a'.repeat(256 * 1024);
    const uploaded = await call('/api/test/upload', { method: 'PUT', headers: { ...headers, Origin: PUBLIC_ORIGIN,
      'Content-Type': 'application/octet-stream', 'X-Filename': 'test.bin' }, body: payload });
    assert.equal(uploaded.status, 200);
    assert.equal(JSON.parse(uploaded.text).body, payload);
    const upstream = forwarded.at(-1).headers;
    assert.equal(upstream.cookie, undefined);
    assert.equal(upstream.authorization, undefined);
    assert.equal(upstream['x-forwarded-host'], undefined);
    assert.equal(upstream.origin, `http://127.0.0.1:${mainPort}`);
    const media = await call('/media/test.mp4', { headers: { Cookie: cookie, Range: 'bytes=1-3' } });
    assert.equal(media.status, 206);
    assert.equal(media.text, 'bcd');
    assert.equal(media.headers['content-range'], 'bytes 1-3/5');
    assert.equal(media.headers['cache-control'], 'private, no-store');
    assert.equal(media.headers['set-cookie'], undefined);
    assert.equal(media.headers['access-control-allow-origin'], undefined);
    assert.equal(media.headers['content-security-policy'], 'sandbox');
    assert.equal(media.headers['referrer-policy'], 'same-origin');
    assert.equal(forwarded.at(-1).headers.range, 'bytes=1-3');
    assert.equal((await call('/api/events', { headers: { Cookie: cookie } })).text, 'data: first\n\ndata: last\n\n');
  });

  await suite.test('cookie mutations require same-origin provenance and cannot reach connector administration', async () => {
    for (const origin of [undefined, 'null', 'https://evil.example', PUBLIC_ORIGIN + '.evil']) {
      const headers = { Cookie: cookie, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) };
      assert.equal((await call('/api/test', { method: 'POST', headers, body: '{}' })).status, 403);
    }
    assert.equal((await call('/api/test', { method: 'POST', headers: { ...mutateHeaders, Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' }, body: '{}' })).status, 403);
    for (const target of ['/api/connector', '/api/connector/password', '/api/connector/app-pairing', '/%61pi/connector', '/api/%63onnector/sessions']) {
      assert.equal((await call(target, { headers: { Cookie: cookie } })).status, 404, target);
    }
    for (const target of ['/api/settings', '/api/%73ettings/']) {
      assert.equal((await call(target, { method: 'PATCH', headers: { ...mutateHeaders, Cookie: cookie },
        body: JSON.stringify({ 'connector.publicUrl': 'https://evil.example' }) })).status, 403);
    }
  });

  await suite.test('raw and encoded path confusion cannot bypass access checks', async () => {
    const paths = ['/api/../api/connector', '/api/%2e%2e/api/connector', '/api%2fconnector', '/api/%2563onnector',
      '/api/connector%5csessions', '/api//connector', '//example.org/api/test', '/api/%00test', '/api/%zz',
      'http://example.org/api/test', '/api\\connector'];
    for (const target of paths) assert.equal((await call(target, { headers: { Cookie: cookie } })).status, 400, target);
    for (const target of paths) assert.throws(() => parseGatewayUrl(target));
  });

  await suite.test('MCP retains OAuth PKCE and bearer sessions, with a separate audience from app cookies', async () => {
    assert.equal((await call('/mcp', { method: 'POST', headers: { Cookie: cookie }, body: '{}' })).status, 401);
    const metadata = JSON.parse((await call('/.well-known/oauth-authorization-server')).text);
    assert.equal(metadata.issuer, PUBLIC_ORIGIN);
    const registered = await call('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://localhost:54321/callback'], token_endpoint_auth_method: 'none', client_name: 'Gateway regression' }) });
    assert.equal(registered.status, 201);
    const client = JSON.parse(registered.text);
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://localhost:54321/callback',
      response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, state: 'preserved' });
    const authorization = await call('/authorize?' + query);
    assert.equal(authorization.status, 200);
    const requestId = /name="request" value="([\w-]+)"/.exec(authorization.text)[1];
    const completed = await call('/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request: requestId, password: PASSWORD, action: 'allow' }).toString() });
    assert.equal(completed.status, 303);
    const callback = new URL(completed.headers.location);
    assert.equal(callback.searchParams.get('state'), 'preserved');
    const exchanged = await call('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code: callback.searchParams.get('code'),
        redirect_uri: 'http://localhost:54321/callback', code_verifier: verifier }).toString() });
    assert.equal(exchanged.status, 200);
    mcpToken = JSON.parse(exchanged.text).access_token;
    const mcp = await call('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${mcpToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    assert.equal(mcp.status, 200);
    assert.equal(JSON.parse(mcp.text).result.serverInfo.name, 'jakes-brain');
    assert.equal((await call('/api/test', { headers: { Authorization: `Bearer ${mcpToken}` } })).status, 401);
    assert.equal((await call('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${cookie.split('=')[1]}` }, body: '{}' })).status, 401);
  });

  await suite.test('pairing is private, hashed, short lived and one-use; native redemption returns the cookie', async () => {
    const mint = (headers = {}) => request(mainPort, '/api/connector/app-pairing', { method: 'POST', publicHost: false,
      headers: { 'Content-Type': 'application/json', 'X-Jakes-Brain-Pairing': 'local-owner', ...headers }, body: '{}' });
    assert.equal((await mint({ Origin: 'https://evil.example' })).status, 403);
    assert.equal((await mint({ 'Content-Type': 'text/plain' })).status, 403);
    assert.equal((await mint({ 'X-Jakes-Brain-Pairing': '' })).status, 403);
    const minted = JSON.parse((await mint()).text);
    assert.equal(minted.redeemPath, '/app-pair');
    assert.equal(minted.url, PUBLIC_ORIGIN);
    assert.equal(store.db.prepare('SELECT hash FROM connector_app_pairings').get().hash, digest(minted.token));
    const pair = (headers = mutateHeaders) => call('/app-pair', { method: 'POST', headers, body: JSON.stringify({ token: minted.token }) });
    assert.equal((await pair({ ...mutateHeaders, Origin: 'https://evil.example' })).status, 403);
    const paired = await pair();
    assert.equal(paired.status, 200);
    assert.deepEqual(JSON.parse(paired.text), { ok: true });
    assert.match(paired.headers['set-cookie'][0], new RegExp(`^${APP_COOKIE}=`));
    assert.equal((await pair()).status, 401);
    const expired = JSON.parse((await mint()).text);
    store.db.prepare('UPDATE connector_app_pairings SET expires_at = 0').run();
    assert.equal((await call('/app-pair', { method: 'POST', headers: mutateHeaders, body: JSON.stringify({ token: expired.token }) })).status, 401);
    assert.throws(() => requireLocalPairingRequest({ socket: { remoteAddress: '100.64.0.5' }, headers: {} }, mainPort));
  });

  await suite.test('app expiry, single-device logout, password changes and sign-out-all revoke access', async () => {
    const previous = cookie;
    const logout = await call('/app-logout', { method: 'POST', headers: { Cookie: cookie, Origin: PUBLIC_ORIGIN } });
    assert.equal(logout.status, 303);
    assert.equal(logout.headers.location, '/app-login');
    assert.equal(logout.headers['referrer-policy'], 'same-origin');
    assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
    assert.equal((await call('/api/test', { headers: { Cookie: previous } })).status, 401);
    cookie = (await login()).headers['set-cookie'][0].split(';')[0];
    store.db.prepare('UPDATE connector_app_sessions SET expires_at = 0').run();
    assert.equal((await call('/api/test', { headers: { Cookie: cookie } })).status, 401);
    cookie = (await login()).headers['set-cookie'][0].split(';')[0];
    await adminAuth.setPassword('Replacement test password 9283');
    assert.equal((await call('/api/test', { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await call('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${mcpToken}` }, body: '{}' })).status, 401);
    cookie = (await login('Replacement test password 9283')).headers['set-cookie'][0].split(';')[0];
    const pendingPair = adminAuth.createAppPairing();
    const signedOut = await request(mainPort, '/api/connector/sessions', { method: 'DELETE', publicHost: false });
    assert.equal(signedOut.status, 200);
    assert.equal((await call('/api/test', { headers: { Cookie: cookie } })).status, 401);
    assert.equal(adminAuth.redeemAppPairing(pendingPair.token), false);
  });

  await suite.test('password work is bounded and sign-out invalidates an in-flight password check', async () => {
    const inFlight = adminAuth.tryPassword('Replacement test password 9283');
    await assert.rejects(adminAuth.tryPassword('Replacement test password 9283'), (error) => error.status === 429);
    adminAuth.signOutAll();
    assert.equal(await inFlight, false);
    await adminAuth.setPassword(PASSWORD);
    for (let index = 0; index < 5; index += 1) assert.equal(await adminAuth.tryPassword('wrong'), false);
    await assert.rejects(adminAuth.tryPassword(PASSWORD), (error) => error.status === 429);
  });
});
