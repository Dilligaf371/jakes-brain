// Reels: a phone view of the reels tracker on this PC (:3000). Read-only.
// Routes: GET /api/reels/proposals, /api/reels/hooks, /api/reels/top
import { HttpError } from '../http.js';
import { cached } from './_lib.js';

export default {
  id: 'reels',
  migrations: [],
  register(r, { cfg, tools }) {
    const base = String(cfg.tracker?.url || 'http://127.0.0.1:3000').replace(/\/$/, '');
    const username = cfg.tracker?.username || 'jakebeau_';
    const get = async (path) => {
      try {
        return await tools.fetchJson(`${base}${path}`, { timeout: 8000 });
      } catch (err) {
        throw new HttpError(502, `reels tracker unavailable: ${err?.message || err}`);
      }
    };

    const proposals = cached(60_000, async () => {
      const { items = [] } = await get('/api/proposed-reels');
      return items.slice(0, 40).map(({ id, batch_date, source, title, hook, script, on_screen, caption, status }) =>
        ({ id, batch_date, source, title, hook, script, on_screen, caption, status }));
    });
    const hooks = cached(60_000, async () => {
      const { items = [] } = await get('/api/hook-makers?limit=20');
      return items.flatMap((maker) => (maker.proposals || []).map((h) =>
        ({ id: h.id, batch_date: h.batch_date, maker: h.maker_name || maker.name, hook: h.hook, reason: h.reason, status: h.status }))).slice(0, 60);
    });
    const top = cached(300_000, async () => {
      const creators = await get('/api/creators');
      const me = (Array.isArray(creators) ? creators : creators.creators || []).find((c) => c.username === username);
      if (!me) throw new HttpError(404, `${username} is not in the tracker`);
      const reels = await get(`/api/reels?creator=${me.id}`);
      return reels.filter((reel) => !reel.is_sponsored).sort((a, b) => (b.latest_views || 0) - (a.latest_views || 0)).slice(0, 30)
        .map((reel) => ({ id: reel.id, url: reel.url, caption: reel.caption || '', posted_at: reel.posted_at, views: reel.latest_views || 0, likes: reel.latest_likes || 0, comments: reel.latest_comments || 0, median: reel.creator_median_views || 0 }));
    });

    r.get('/api/reels/proposals', async () => ({ items: await proposals() }));
    r.get('/api/reels/hooks', async () => ({ items: await hooks() }));
    r.get('/api/reels/top', async () => ({ items: await top() }));
  },
};
