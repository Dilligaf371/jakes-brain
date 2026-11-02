// Graph: an Obsidian-like graph of all of Jake's data, built READ-ONLY from the other apps'
// tables (notes, tasks, calendar_events, gram_posts, tube_videos, gpt_conversations, habits +
// habit_checks). This module owns no tables: a table that does not exist yet (an app not built
// yet) is simply skipped, and a table whose columns differ from SPEC.md is skipped with a
// warning instead of failing the whole graph.
//
//   GET /api/graph            -> { nodes, edges, generated_at, truncated, counts, missing }
//                                cached 30 s (?refresh=1 rebuilds now)
//
// Node:  { id: '<type>:<rowid>', type, label, app, route, date: 'YYYY-MM-DD'|null, meta: {...} }
//        types: note task event post video chat habit (items) + day tag (hubs)
// Edge:  { source, target, kind }   kinds: day (item<->day), tag (item<->tag), link (note->note)
//
// Caps: at most 2000 nodes. Over that, the oldest day clusters (the day hub + the items whose
// day it is) are dropped first and `truncated` is true.
import { cached } from './_lib.js';
import { readLogs } from './daylog.js';
import { HttpError } from '../http.js';

const CACHE_MS = 30_000;
const NODE_CAP = 2000;
const HABIT_WINDOW_DAYS = 60;
const LABEL_MAX = 80;
const TAG_MAX = 40;
const SESSION_GAP_MS = 25 * 60_000;   // clips closer than this are one recording session
const EXTERNAL_MS = 5 * 60_000;
const ITEM_TOPICS = 5;                // keep an item's rarest topics, so links stay meaningful
const DAY_TOPICS = 12;
// Too generic to connect anything; every reel would land on the same hub.
const TOPIC_STOP = new Set(['ai', 'ad', 'ads', 'tech', 'eli5', 'creative', 'creator', 'content', 'video', 'reel', 'new', 'app', 'apps', 'tool', 'code', 'coding', 'build', 'building']);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// "#focus", "#deep-work", "#3d": a # that does not follow a word char, '#', '&' or '/'
// (so URL fragments and "&#39;" are not tags), then letters/digits/_/-; needs a letter.
const TAG_RE = /(^|[^\p{L}\p{N}_#&/])#([\p{L}\p{N}_-]{1,60})/gu;
const HAS_LETTER_RE = /\p{L}/u;
const HEX_COLOR_RE = /^[0-9a-f]{6}$/i;
// [[Title]], [[Title|alias]], [[Title#heading]]
const LINK_RE = /\[\[([^[\]|#\n]+)(?:[|#][^\]\n]*)?\]\]/g;

const ITEM_TYPES = ['note', 'task', 'event', 'post', 'video', 'chat', 'habit'];
const SOURCE_TABLES = ['notes', 'tasks', 'calendar_events', 'gram_posts', 'tube_videos', 'gpt_conversations', 'habits', 'habit_checks'];

export default {
  id: 'graph',
  migrations: [
    {
      // The graph owns no tables: it only reads the other apps'. Recorded so the registry
      // shows the module ran; the statement is a no-op.
      id: 'graph-1',
      sql: 'SELECT 1;',
    },
  ],
  register(r, ctx) {
    let cache = null; // { at, data }

    const root = ctx.expandHome(ctx.cfg.daylog?.root || '~/Videos/pocket3-vlog/vlogs');
    const base = String(ctx.cfg.tracker?.url || 'http://127.0.0.1:3000').replace(/\/$/, '');
    const username = ctx.cfg.tracker?.username || 'jakebeau_';
    let lastExternal = { reels: [], ideas: [], hooks: [], logs: [] };
    const external = cached(EXTERNAL_MS, async () => {
      const get = (path) => ctx.tools.fetchJson(`${base}${path}`, { timeout: 6000 });
      const logs = await readLogs(root).catch(() => []);
      try {
        const creators = await get('/api/creators');
        const me = (Array.isArray(creators) ? creators : creators.creators || []).find((c) => c.username === username);
        const [reels, ideas, makers] = await Promise.all([
          me ? get(`/api/reels?creator=${me.id}`) : [], get('/api/proposed-reels'), get('/api/hook-makers?limit=60'),
        ]);
        lastExternal = { reels: Array.isArray(reels) ? reels : [], ideas: ideas.items || [], hooks: (makers.items || []).flatMap((m) => m.proposals || []), logs };
      } catch (err) {
        ctx.log.warn(`graph: reels tracker unavailable: ${err?.message || err}`);
        lastExternal = { ...lastExternal, logs };
      }
      return lastExternal;
    });

    r.get('/api/graph', async (req, res, { query }) => {
      const refresh = query.refresh === '1' || query.refresh === 'true';
      if (query.refresh !== undefined && !refresh && query.refresh !== '0' && query.refresh !== 'false' && query.refresh !== '') {
        throw new HttpError(400, 'refresh must be 1 or 0');
      }
      if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
      const data = buildGraph({ ...ctx, external: await external() });
      cache = { at: Date.now(), data };
      return data;
    });
  },
};

// ---------------------------------------------------------------- build

export function buildGraph({ db, log, external = {} }) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)));
  const nodes = new Map();           // id -> node
  const edges = [];
  const edgeKeys = new Set();
  const dayMembers = new Map();      // 'YYYY-MM-DD' -> [item node ids whose own day it is]
  const tagged = [];                 // [nodeId, text] to scan for #tags
  const notesByTitle = new Map();    // lower-cased title -> note node id
  const noteBodies = [];             // [nodeId, text] to scan for [[links]]
  const missing = [];
  const today = localDay(new Date());

  const addNode = (node) => {
    nodes.set(node.id, node);
    return node;
  };
  const addEdge = (source, target, kind) => {
    if (source === target) return;
    const key = `${source}\n${target}\n${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ source, target, kind });
  };
  const ensureDay = (day) => {
    const id = `day:${day}`;
    if (!nodes.has(id)) {
      addNode({ id, type: 'day', label: dayLabel(day, today), app: 'calendar', route: `#/calendar/${day.slice(0, 7)}`, date: day, meta: {} });
    }
    return id;
  };
  // An item's own day: the day hub edge, and membership for the truncation rule.
  const linkDay = (nodeId, day) => {
    if (!day) return;
    addEdge(nodeId, ensureDay(day), 'day');
    if (!dayMembers.has(day)) dayMembers.set(day, []);
    dayMembers.get(day).push(nodeId);
  };
  // Runs fn when the table exists; a schema that differs from SPEC.md skips that app.
  const from = (table, fn) => {
    if (!tables.has(table)) {
      missing.push(table);
      return;
    }
    try {
      fn();
    } catch (err) {
      log.warn(`skipping ${table}: ${err && err.message ? err.message : err}`);
    }
  };

  from('notes', () => {
    for (const row of db.prepare('SELECT id, title, body, pinned, created_at, updated_at FROM notes ORDER BY id').all()) {
      const id = `note:${row.id}`;
      const title = clean(row.title);
      const body = String(row.body == null ? '' : row.body);
      const label = title || firstLine(body) || 'Untitled';
      const day = localDay(row.created_at);
      addNode({ id, type: 'note', label: trimLabel(label), app: 'notes', route: `#/notes/${row.id}`, date: day,
        meta: { pinned: Boolean(row.pinned), updated_at: row.updated_at || null } });
      linkDay(id, day);
      tagged.push([id, `${title}\n${body}`]);
      if (title) notesByTitle.set(title.toLowerCase(), id);
      noteBodies.push([id, body]);
    }
  });

  from('tasks', () => {
    for (const row of db.prepare('SELECT id, text, done, created_at FROM tasks ORDER BY id').all()) {
      const id = `task:${row.id}`;
      const text = clean(row.text);
      const day = localDay(row.created_at);
      addNode({ id, type: 'task', label: trimLabel(text || 'Task'), app: 'tasks', route: '#/tasks', date: day, meta: { done: Boolean(row.done) } });
      linkDay(id, day);
      tagged.push([id, text]);
    }
  });

  from('calendar_events', () => {
    for (const row of db.prepare('SELECT id, title, date, start_time, end_time, all_day, notes FROM calendar_events ORDER BY id').all()) {
      const id = `event:${row.id}`;
      const title = clean(row.title);
      const day = DAY_RE.test(String(row.date || '')) ? String(row.date) : null;
      addNode({ id, type: 'event', label: trimLabel(title || 'Event'), app: 'calendar', route: day ? `#/calendar/${day.slice(0, 7)}` : '#/calendar', date: day,
        meta: { start_time: row.start_time || null, end_time: row.end_time || null, all_day: Boolean(row.all_day) } });
      linkDay(id, day);
      tagged.push([id, `${title}\n${row.notes == null ? '' : row.notes}`]);
    }
  });

  from('gram_posts', () => {
    for (const row of db.prepare('SELECT id, kind, thumb, file, caption, liked, created_at FROM gram_posts ORDER BY id').all()) {
      const id = `post:${row.id}`;
      const caption = clean(row.caption);
      const kind = row.kind === 'video' ? 'video' : 'image';
      const day = localDay(row.created_at);
      addNode({ id, type: 'post', label: trimLabel(firstLine(caption) || (kind === 'video' ? 'Video' : 'Photo')), app: 'jakestagram',
        route: `#/jakestagram/p/${row.id}`, date: day, meta: { kind, thumb: row.thumb || row.file || null, liked: Boolean(row.liked) } });
      linkDay(id, day);
      tagged.push([id, caption]);
    }
  });

  // Recordings are cut into 1 to 20 minute clips, so consecutive clips become one session node.
  from('tube_videos', () => {
    const clips = db.prepare('SELECT id, channel, name, mtime, duration FROM tube_videos').all()
      .map((row) => ({ ...row, start: clipStart(row) }))
      .sort((x, y) => String(x.channel).localeCompare(String(y.channel)) || x.start - y.start);
    const sessions = [];
    for (const clip of clips) {
      const last = sessions.at(-1);
      const tail = last?.at(-1);
      const joins = tail && clip.channel !== 'vlogs' && tail.channel === clip.channel && clip.start - tail.start <= SESSION_GAP_MS;
      if (joins) last.push(clip);
      else sessions.push([clip]);
    }
    for (const group of sessions) {
      const first = group[0];
      const id = `video:${first.id}`;
      const day = Number.isFinite(first.start) ? localDay(new Date(first.start)) : null;
      const duration = group.reduce((sum, clip) => sum + (Number(clip.duration) || 0), 0);
      const label = group.length > 1 ? `${dayLabel(day, today)}, ${group.length} clips` : readableVideoName(first.name);
      addNode({ id, type: 'video', label: trimLabel(label), app: 'jaketube', route: `#/jaketube/watch/${first.id}`, date: day,
        meta: { channel: first.channel || null, duration: duration || null, clips: group.length } });
      linkDay(id, day);
    }
  });

  from('gpt_conversations', () => {
    for (const row of db.prepare('SELECT id, title, model, created_at FROM gpt_conversations ORDER BY id').all()) {
      const id = `chat:${row.id}`;
      const title = clean(row.title);
      const day = localDay(row.created_at);
      addNode({ id, type: 'chat', label: trimLabel(title || 'New chat'), app: 'jakegpt', route: `#/jakegpt/${row.id}`, date: day, meta: { model: row.model || null } });
      linkDay(id, day);
      tagged.push([id, title]);
    }
  });

  from('habits', () => {
    const habitIds = new Set();
    for (const row of db.prepare('SELECT id, name, color, created_at, archived FROM habits ORDER BY id').all()) {
      const id = `habit:${row.id}`;
      habitIds.add(String(row.id));
      addNode({ id, type: 'habit', label: trimLabel(clean(row.name) || 'Habit'), app: 'habits', route: '#/habits', date: localDay(row.created_at),
        meta: { color: row.color || null, archived: Boolean(row.archived), checks: 0 } });
    }
    if (!habitIds.size) return;
    from('habit_checks', () => {
      const since = shiftDay(today, -HABIT_WINDOW_DAYS);
      for (const row of db.prepare('SELECT habit_id, date FROM habit_checks WHERE date >= ? AND date <= ? ORDER BY date').all(since, today)) {
        const habitId = `habit:${row.habit_id}`;
        const day = String(row.date || '');
        if (!habitIds.has(String(row.habit_id)) || !DAY_RE.test(day)) continue;
        addEdge(habitId, ensureDay(day), 'day');
        nodes.get(habitId).meta.checks += 1;
      }
    });
  });

  // #tags
  // Added apps: deals, people, saved links, focus sessions.
  const peopleByHandle = new Map();
  from('people', () => {
    for (const row of db.prepare('SELECT id, name, handle, role, notes FROM people').all()) {
      const id = `person:${row.id}`;
      addNode({ id, type: 'person', label: trimLabel(clean(row.name)), app: 'people', route: `#/people/${row.id}`, date: null, meta: { role: row.role } });
      peopleByHandle.set(String(row.handle).toLowerCase(), id);
      tagged.push([id, String(row.notes || '')]);
    }
  });
  from('deals', () => {
    for (const row of db.prepare('SELECT id, brand, status, due_date, deliverables, notes, created_at FROM deals').all()) {
      const id = `deal:${row.id}`;
      addNode({ id, type: 'deal', label: trimLabel(clean(row.brand)), app: 'deals', route: `#/deals/${row.id}`, date: row.due_date || localDay(row.created_at), meta: { status: row.status } });
      linkDay(id, row.due_date || localDay(row.created_at));
      tagged.push([id, `${row.deliverables}\n${row.notes}`]);
    }
  });
  from('saved_links', () => {
    for (const row of db.prepare('SELECT id, title, site, created_at FROM saved_links').all()) {
      const id = `link:${row.id}`;
      const day = localDay(row.created_at);
      addNode({ id, type: 'link', label: trimLabel(clean(row.title)), app: 'saved', route: `#/saved/${row.id}`, date: day, meta: { site: row.site } });
      linkDay(id, day);
      tagged.push([id, String(row.title)]);
    }
  });
  from('focus_sessions', () => {
    for (const row of db.prepare('SELECT id, label, minutes, started_at FROM focus_sessions').all()) {
      const id = `focus:${row.id}`;
      const day = localDay(row.started_at);
      addNode({ id, type: 'focus', label: trimLabel(clean(row.label) || `Focus ${Math.round(row.minutes)}m`), app: 'focus', route: '#/focus', date: day, meta: {} });
      linkDay(id, day);
      tagged.push([id, String(row.label || '')]);
    }
  });
  // Reels, reel ideas, hooks and day logs join the graph through the topics they share.
  const topicTexts = tagged.map(([nodeId, text]) => [nodeId, String(text)]);
  const vocab = new Map();           // slug -> { label, uses }
  const countTopic = (raw) => {
    const word = topicWord(raw);
    if (!word) return;
    const slug = topicSlug(word);
    const entry = vocab.get(slug) || { label: word, uses: 0 };
    entry.uses += 1;
    vocab.set(slug, entry);
  };
  const handles = new Map();         // @handle -> reel node ids
  const reelIds = new Set();
  for (const reel of external.reels || []) {
    const id = `reel:${reel.id}`;
    const caption = String(reel.caption || '');
    const title = firstLine(caption.replace(/[#@][\p{L}\p{N}_.]+/gu, ' ')) || 'Reel';
    addNode({ id, type: 'reel', label: trimLabel(title), app: 'reels', route: null, date: reel.posted_at ? localDay(reel.posted_at) : null,
      meta: { url: /^https:\/\//.test(reel.url || '') ? reel.url : null, views: reel.latest_views || 0, sponsored: Boolean(reel.is_sponsored) } });
    reelIds.add(reel.id);
    topicTexts.push([id, caption]);
    for (const tag of new Set(caption.match(/#[\p{L}\p{N}_]+/gu) || [])) countTopic(tag);
    for (const handle of new Set(caption.match(/(?<![\p{L}\p{N}_.])@[\p{L}\p{N}_.]+/gu) || [])) {
      const key = handle.toLowerCase().replace(/\.+$/, '');
      handles.set(key, [...(handles.get(key) || []), id]);
    }
  }
  for (const idea of external.ideas || []) {
    const id = `idea:${idea.id}`;
    addNode({ id, type: 'idea', label: trimLabel(clean(idea.title) || 'Reel idea'), app: 'reels', route: `#/reels/idea/${idea.id}`, date: idea.batch_date || null, meta: { source: idea.source || null } });
    topicTexts.push([id, `${idea.title}\n${idea.hook}\n${idea.script}\n${idea.caption}`]);
    for (const word of parseList(idea.trend_keywords)) countTopic(word);
    for (const reelId of parseList(idea.grounding_reel_ids)) if (reelIds.has(reelId)) addEdge(id, `reel:${reelId}`, 'link');
  }
  for (const hook of external.hooks || []) {
    const id = `hook:${hook.id}`;
    addNode({ id, type: 'hook', label: trimLabel(clean(hook.hook) || 'Hook'), app: 'reels', route: '#/reels', date: hook.batch_date || null, meta: { maker: hook.maker_name || null } });
    topicTexts.push([id, `${hook.hook}\n${hook.reason}`]);
  }
  for (const day of external.logs || []) {
    const id = ensureDay(day.date);
    const node = nodes.get(id);
    node.route = `#/daylog/${day.date}`;
    node.app = 'daylog';
    topicTexts.push([id, day.blocks.map((block) => block.text).join(' ')]);
  }
  for (const [handle, reels] of handles) {
    if (reels.length < 2) continue;
    const id = `tag:${handle}`;
    addNode({ id, type: 'tag', label: handle, app: null, route: null, date: null, meta: {} });
    for (const reel of reels) addEdge(reel, id, 'tag');
  }
  const topics = [...vocab].filter(([, entry]) => entry.uses >= 2);
  if (topics.length) {
    const alternatives = topics.map(([, entry]) => entry.label).sort((x, y) => y.length - x.length)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+'));
    const finder = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})s?(?![\\p{L}\\p{N}])`, 'giu');
    const found = [];
    const reach = new Map();
    for (const [nodeId, text] of topicTexts) {
      const slugs = new Set();
      for (const hit of text.matchAll(finder)) {
        const slug = topicSlug(hit[0].toLowerCase().replace(/[\s-]+/g, ' ').replace(/(?<=.{4})s$/, ''));
        if (vocab.has(slug)) slugs.add(slug);
      }
      found.push([nodeId, slugs]);
      for (const slug of slugs) reach.set(slug, (reach.get(slug) || 0) + 1);
    }
    const ceiling = Math.max(30, Math.round(found.length * 0.12));
    for (const [nodeId, slugs] of found) {
      const useful = [...slugs].filter((slug) => reach.get(slug) >= 2 && reach.get(slug) <= ceiling).sort((x, y) => reach.get(x) - reach.get(y));
      for (const slug of useful.slice(0, nodeId.startsWith('day:') ? DAY_TOPICS : ITEM_TOPICS)) {
        const id = `tag:${slug}`;
        if (!nodes.has(id)) addNode({ id, type: 'tag', label: vocab.get(slug).label, app: null, route: null, date: null, meta: {} });
        addEdge(nodeId, id, 'tag');
      }
    }
  }

  for (const [nodeId, text] of tagged) {
    for (const match of String(text).matchAll(/(^|[^\p{L}\p{N}_@./])@([\p{L}\p{N}_.-]{1,40})/gu)) {
      const person = peopleByHandle.get(match[2].toLowerCase().replace(/[.-]+$/, ''));
      if (person) addEdge(nodeId, person, 'mention');
    }
  }

  for (const [nodeId, text] of tagged) {
    for (const tag of findTags(text)) {
      const id = `tag:${tag}`;
      if (!nodes.has(id)) addNode({ id, type: 'tag', label: `#${tag}`, app: null, route: null, date: null, meta: { count: 0 } });
      addEdge(nodeId, id, 'tag');
    }
  }

  // [[links]] note -> note by title (case-insensitive)
  for (const [nodeId, body] of noteBodies) {
    for (const title of findLinks(body)) {
      const target = notesByTitle.get(title.toLowerCase());
      if (target && target !== nodeId) addEdge(nodeId, target, 'link');
    }
  }

  let truncated = false;
  if (nodes.size > NODE_CAP) {
    truncated = true;
    const days = [...dayMembers.keys()].sort(); // oldest first
    for (const day of days) {
      if (nodes.size <= NODE_CAP) break;
      for (const memberId of dayMembers.get(day)) nodes.delete(memberId);
      nodes.delete(`day:${day}`);
    }
    if (nodes.size > NODE_CAP) {
      // One enormous day (or thousands of undated items): keep the newest items.
      const items = [...nodes.values()].filter((n) => ITEM_TYPES.includes(n.type));
      items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      for (const node of items.slice(Math.max(0, NODE_CAP - (nodes.size - items.length)))) nodes.delete(node.id);
    }
  }

  // Drop edges that lost an end, then hubs that lost every edge.
  let kept = edges.filter((e) => nodes.has(e.source) && nodes.has(e.target));
  const degree = new Map();
  for (const e of kept) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  for (const node of [...nodes.values()]) {
    if ((node.type === 'day' || node.type === 'tag') && !degree.get(node.id)) nodes.delete(node.id);
  }
  kept = kept.filter((e) => nodes.has(e.source) && nodes.has(e.target));
  for (const node of nodes.values()) if (node.type === 'tag') node.meta.count = degree.get(node.id) || 0;

  const counts = {};
  for (const node of nodes.values()) counts[node.type] = (counts[node.type] || 0) + 1;

  return {
    nodes: [...nodes.values()],
    edges: kept,
    generated_at: new Date().toISOString(),
    truncated,
    counts,
    missing: missing.filter((t) => SOURCE_TABLES.includes(t)),
  };
}

// ---------------------------------------------------------------- helpers

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function firstLine(text) {
  const line = String(text == null ? '' : text).split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.replace(/^#+\s*/, '').replace(/\s+/g, ' ');
}

function trimLabel(label) {
  const s = String(label == null ? '' : label);
  return s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1).trimEnd()}…` : s;
}

export function findTags(text) {
  const out = new Set();
  const s = String(text == null ? '' : text);
  for (const m of s.matchAll(TAG_RE)) {
    const raw = m[2].replace(/[-_]+$/, '').toLowerCase();
    if (!raw || raw.length > TAG_MAX || !HAS_LETTER_RE.test(raw) || HEX_COLOR_RE.test(raw)) continue;
    out.add(raw);
  }
  return out;
}

export function findLinks(text) {
  const out = new Set();
  for (const m of String(text == null ? '' : text).matchAll(LINK_RE)) {
    const title = m[1].trim();
    if (title) out.add(title);
  }
  return out;
}

// ISO string / Date / epoch (ms or s) -> Date or null
function toDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n > 1e11 ? n : n * 1000);
  }
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : new Date(t);
}

// Local 'YYYY-MM-DD' (the server's timezone) or null.
export function localDay(value) {
  const d = toDate(value);
  if (!d) return null;
  const two = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function shiftDay(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + delta, 12));
}

// "Nov 2", or "Nov 2, 2025" when the year is not the current one.
function dayLabel(day, today) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12);
  const opts = { month: 'short', day: 'numeric' };
  if (String(y) !== today.slice(0, 4)) opts.year = 'numeric';
  return date.toLocaleDateString('en-US', opts);
}

// The JakeTube rule: 2026-10-15.mp4 -> "Oct 15, 2026"; 2026-10-15_19-07-48.mp4 ->
// "Oct 15, 2026 · 7:07 PM"; anything else -> the file stem.
export function readableVideoName(name) {
  const stem = String(name == null ? '' : name).replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[_ T-](\d{2})[-:.](\d{2})[-:.](\d{2}))?$/.exec(stem);
  if (!m) return stem || 'Video';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 12), Number(m[5] || 0), Number(m[6] || 0));
  if (Number.isNaN(d.getTime())) return stem;
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (m[4] === undefined) return date;
  return `${date} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
}

// Recording start from a name like 2026-10-15_19-07-48 or 2025-03-25 05-44-04, else file time.
function clipStart(row) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ _](\d{2})-(\d{2})-(\d{2})/.exec(String(row.name));
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return new Date(toDate(row.mtime) || dateFromName(row.name) || NaN).getTime();
}

function topicWord(raw) {
  let word = String(raw || '').toLowerCase().replace(/^#/, '').replace(/\s+/g, ' ').trim();
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) word = word.slice(0, -1);
  if (word.length < 3 || word.length > 40 || TOPIC_STOP.has(word) || /partner|sponsor/.test(word)) return '';
  return word;
}

const topicSlug = (word) => word.replace(/\s+/g, '-');

// The tracker stores some lists as JSON text.
function parseList(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function dateFromName(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(name == null ? '' : name));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return Number.isNaN(d.getTime()) ? null : d;
}
