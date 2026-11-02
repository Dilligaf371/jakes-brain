// Bots: READ-ONLY status of the Zora bot and the feed accounts. The Zora bot trades real money,
// so this module only ever reads their files and exposes no action of any kind.
// Route: GET /api/bots/status
import fsp from 'node:fs/promises';
import path from 'node:path';
import { cached } from './_lib.js';

const readJson = async (file) => {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

async function zora(dir) {
  const status = await readJson(path.join(dir, 'status.json'));
  if (!status) return null;
  const books = Object.entries(status.books || {}).map(([id, b]) => ({
    id, what: b.what || '', real_money: Boolean(b.real_money), closed: b.closed_trades || 0, wins: b.wins || 0,
    pnl_total: b.pnl_usd_total || 0, pnl_today: b.pnl_usd_today || 0, open: (b.open_positions || []).length,
  }));
  books.sort((a, b) => Number(b.real_money) - Number(a.real_money));
  const updated = status.updated_utc ? `${status.updated_utc.replace(' ', 'T')}Z` : null;
  return { mode: status.mode || 'unknown', updated, books };
}

async function feed(dir) {
  const [accounts, control, state] = await Promise.all([
    readJson(path.join(dir, 'accounts.json')), readJson(path.join(dir, 'control.json')), readJson(path.join(dir, 'state', 'state.json')),
  ]);
  if (!Array.isArray(accounts)) return null;
  const rows = await Promise.all(accounts.map(async (a) => {
    const queue = await readJson(path.join(dir, 'queues', `${a.id}.json`));
    const stamps = [];
    for (const slots of Object.values(state?.posted?.[a.id] || {})) {
      for (const slot of Object.values(slots || {})) if (slot?.status === 'posted' && slot.at) stamps.push(slot.at);
    }
    for (const item of Object.values(state?.postedItems?.[a.id] || {})) if (item?.at) stamps.push(item.at);
    return {
      id: a.id, name: a.name || a.id, platform: a.platform || '', handle: a.handle || '',
      enabled: control?.enabled ? control.enabled[a.id] === true : true,
      queued: Array.isArray(queue?.items) ? queue.items.filter((item) => item.status === 'queued').length : null,
      last_post: stamps.sort().at(-1) || null,
    };
  }));
  // Accounts planned but never switched on are noise here.
  return { live: control?.live !== false, accounts: rows.filter((a) => a.enabled || a.last_post) };
}

export default {
  id: 'bots',
  migrations: [],
  register(r, { cfg, expandHome }) {
    const zoraDir = expandHome(cfg.bots?.zoraState || '~/zora-bot/live/state');
    const feedDir = expandHome(cfg.bots?.feedDir || '~/feed-accounts');
    const load = cached(20_000, async () => ({ zora: await zora(zoraDir), feed: await feed(feedDir) }));
    r.get('/api/bots/status', () => load());
  },
};
