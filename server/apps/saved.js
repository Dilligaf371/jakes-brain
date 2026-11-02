// Saved: paste a link and the PC stores the page text for a private, searchable read-later list.
// Routes: GET/POST /api/saved, GET/PATCH/DELETE /api/saved/:id
import dns from 'node:dns/promises';
import net from 'node:net';
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';
import { now, parseId, text } from './_lib.js';

const MAX_HTML = 3 * 1024 * 1024;
const MAX_TEXT = 200_000;
const TIMEOUT_MS = 12_000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

function isPrivate(ip) {
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low.startsWith('::ffff:')) return isPrivate(low.slice(7));
    return low === '::1' || low === '::' || /^(fc|fd|fe8|fe9|fea|feb)/.test(low);
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// The server fetches on the phone's behalf, so it must never be pointed at the home network.
async function assertPublic(url) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only http and https links work');
  const found = await dns.lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!found.length || found.some((entry) => isPrivate(entry.address))) throw new Error('that address is on a private network');
}

async function download(start) {
  let url = start;
  for (let hop = 0; hop < 5; hop += 1) {
    await assertPublic(url);
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': UA, accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    if (!res.ok) throw new Error(`the site answered ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!/text\/|xhtml/.test(type)) throw new Error('that link is not a web page');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_HTML) break;
      chunks.push(chunk);
    }
    return { html: Buffer.concat(chunks).toString('utf8'), isHtml: /html/.test(type) };
  }
  throw new Error('too many redirects');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '-', ndash: '-', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };
function decode(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? all;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
  });
}
function meta(html, name) {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i');
  const tag = html.match(pattern)?.[0];
  return tag ? decode(tag.match(/content=["']([^"']*)["']/i)?.[1] || '').trim() : '';
}
function extract(html) {
  const title = meta(html, 'og:title') || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  let body = html.replace(/<(script|style|noscript|svg|nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const main = body.match(/<article\b[\s\S]*?<\/article>/i)?.[0] || body.match(/<main\b[\s\S]*?<\/main>/i)?.[0];
  body = (main || body).replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  const content = decode(body).split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n').slice(0, MAX_TEXT);
  return { title, content, excerpt: meta(html, 'og:description') || meta(html, 'description') || content.slice(0, 220) };
}
// node:sqlite truncates at NUL and the page text is untrusted, so drop control characters.
const strip = (value) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

export default {
  id: 'saved',
  migrations: [{
    id: 'saved-1',
    sql: `
      CREATE TABLE IF NOT EXISTS saved_links (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        url        TEXT NOT NULL UNIQUE,
        title      TEXT NOT NULL,
        site       TEXT NOT NULL,
        excerpt    TEXT NOT NULL DEFAULT '',
        content    TEXT NOT NULL DEFAULT '',
        fetch_error TEXT,
        is_read    INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );`,
  }],
  register(r, { db }) {
    const LIST = 'id, url, title, site, excerpt, fetch_error, is_read, created_at';
    const shape = (row) => row && { ...row, is_read: Boolean(row.is_read) };

    r.get('/api/saved', (req, res, { query }) => {
      const q = text(query.q, 'q', { max: 200 });
      const rows = q
        ? db.prepare(`SELECT ${LIST} FROM saved_links WHERE title LIKE ?1 ESCAPE '\\' OR content LIKE ?1 ESCAPE '\\' OR url LIKE ?1 ESCAPE '\\' ORDER BY id DESC LIMIT 200`).all(`%${q.replace(/[\\%_]/g, '\\$&')}%`)
        : db.prepare(`SELECT ${LIST} FROM saved_links ORDER BY is_read, id DESC LIMIT 200`).all();
      return { links: rows.map(shape) };
    });

    r.post('/api/saved', async (req, res) => {
      const raw = text((await readJsonBody(req)).url, 'url', { max: 2000, required: true });
      let url;
      try {
        url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
      } catch {
        throw new HttpError(400, "that doesn't look like a link");
      }
      if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'only http and https links work');
      const existing = db.prepare('SELECT id FROM saved_links WHERE url = ?').get(url.href);
      if (existing) return sendJson(res, 200, { link: shape(db.prepare(`SELECT ${LIST} FROM saved_links WHERE id = ?`).get(existing.id)), existing: true });

      let page = { title: '', content: '', excerpt: '' };
      let failure = null;
      try {
        const { html, isHtml } = await download(url);
        page = isHtml ? extract(html) : { title: '', content: html.slice(0, MAX_TEXT), excerpt: html.slice(0, 220) };
      } catch (err) {
        // Keep the link anyway: a paywall or a dead site should not lose what was pasted.
        failure = err?.name === 'TimeoutError' ? 'the site took too long' : String(err?.message || err).slice(0, 200);
      }
      const made = db.prepare('INSERT INTO saved_links (url, title, site, excerpt, content, fetch_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        url.href, strip(page.title).slice(0, 300) || url.hostname, url.hostname.replace(/^www\./, ''), strip(page.excerpt).slice(0, 400), strip(page.content), failure, now());
      sendJson(res, 201, { link: shape(db.prepare(`SELECT ${LIST} FROM saved_links WHERE id = ?`).get(Number(made.lastInsertRowid))) });
    });

    r.get('/api/saved/:id', (req, res, { params }) => {
      const link = shape(db.prepare('SELECT * FROM saved_links WHERE id = ?').get(parseId(params.id)));
      if (!link) throw new HttpError(404, 'link not found');
      return { link };
    });

    r.patch('/api/saved/:id', async (req, res, { params }) => {
      const id = parseId(params.id);
      const body = await readJsonBody(req);
      if (typeof body.is_read !== 'boolean') throw new HttpError(400, 'is_read must be a boolean');
      if (!db.prepare('UPDATE saved_links SET is_read = ? WHERE id = ?').run(body.is_read ? 1 : 0, id).changes) throw new HttpError(404, 'link not found');
      return { link: shape(db.prepare(`SELECT ${LIST} FROM saved_links WHERE id = ?`).get(id)) };
    });

    r.delete('/api/saved/:id', (req, res, { params }) => {
      if (!db.prepare('DELETE FROM saved_links WHERE id = ?').run(parseId(params.id)).changes) throw new HttpError(404, 'link not found');
      sendEmpty(res, 204);
    });
  },
};
