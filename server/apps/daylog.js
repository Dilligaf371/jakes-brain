// Day Log: a searchable timeline of each day, read from the auto-vlog transcripts at
// <root>/<YYYY-MM-DD>/.work/asr/<YYYY-MM-DD_HH-MM-SS>.json. Read-only.
// Routes: GET /api/daylog/days, /api/daylog/days/:date, /api/daylog/search?q=
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../http.js';
import { cached, text } from './_lib.js';

const BLOCK_MIN = 10;

async function loadDay(root, date) {
  const dir = path.join(root, date, '.work', 'asr');
  const names = (await fsp.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json')).sort();
  const blocks = new Map();
  for (const name of names) {
    const stamp = name.match(/^\d{4}-\d{2}-\d{2}_(\d{2})-(\d{2})-(\d{2})/);
    if (!stamp) continue;
    const startSec = Number(stamp[1]) * 3600 + Number(stamp[2]) * 60 + Number(stamp[3]);
    const data = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8').catch(() => '{}') || '{}');
    for (const region of data.regions || []) {
      if (!region.text) continue;
      const at = startSec + (region.start || 0);
      const key = Math.floor(at / (BLOCK_MIN * 60)) * BLOCK_MIN;
      if (!blocks.has(key)) blocks.set(key, []);
      blocks.get(key).push(region.text.trim());
    }
  }
  const out = [...blocks].sort((a, b) => a[0] - b[0]).map(([minute, parts]) => ({ minute, text: parts.join(' ') }));
  return { date, blocks: out, words: out.reduce((sum, b) => sum + b.text.split(/\s+/).length, 0) };
}

export default {
  id: 'daylog',
  migrations: [],
  register(r, { cfg, expandHome }) {
    const root = expandHome(cfg.daylog?.root || '~/Videos/pocket3-vlog/vlogs');
    const index = cached(300_000, async () => {
      const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
      const dates = entries.filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)).map((e) => e.name).sort().reverse();
      return (await Promise.all(dates.map((date) => loadDay(root, date)))).filter((day) => day.blocks.length);
    });
    const videoId = (date) => {
      try {
        const real = fs.realpathSync(path.join(root, `${date}.mp4`));
        return crypto.createHash('sha1').update(real).digest('hex').slice(0, 16);
      } catch {
        return null;
      }
    };

    r.get('/api/daylog/days', async () => ({
      days: (await index()).map((day) => ({ date: day.date, words: day.words, first: day.blocks[0].minute, last: day.blocks.at(-1).minute, preview: day.blocks[0].text.slice(0, 140) })),
    }));
    r.get('/api/daylog/days/:date', async (req, res, { params }) => {
      const day = (await index()).find((d) => d.date === params.date);
      if (!day) throw new HttpError(404, 'no log for that day');
      return { ...day, video_id: videoId(day.date) };
    });
    r.get('/api/daylog/search', async (req, res, { query }) => {
      const q = text(query.q, 'q', { max: 100 }).toLowerCase();
      if (!q) return { hits: [] };
      const hits = [];
      for (const day of await index()) {
        for (const block of day.blocks) {
          const at = block.text.toLowerCase().indexOf(q);
          if (at < 0) continue;
          hits.push({ date: day.date, minute: block.minute, snippet: block.text.slice(Math.max(0, at - 70), at + q.length + 90) });
          if (hits.length >= 50) return { hits };
        }
      }
      return { hits };
    });
  },
};
