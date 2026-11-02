// Graph app: an Obsidian-like graph of all of Jake's data on a full-bleed <canvas>.
// Data: GET /api/graph (nodes + edges built read-only from the other apps' tables).
// Own force simulation (no library): grid-bucketed repulsion (exact inside the 3x3 cell
// neighbourhood, cell centroids beyond it), spring edges, centre gravity, cooling (~300 ticks)
// and re-heat on drag. Interactions: drag empty space = pan, pinch / wheel = zoom (0.2–4),
// drag a node, tap/click a node = select (neighbours highlighted, bottom card with Open),
// hover (mouse) shows the label, double-tap / double-click empty space = fit.
// Nav bar right: filter + search sheet (type toggles persisted in kit.store 'graph.filters').
// Sub-route #/graph/<nodeId> selects and centres that node.
import * as kit from '../../kit.js';

const { api, el, fmt, toast, haptic, navbar, navButton, icon, store, nav, holdReload, releaseReload, debounce, emptyState } = kit;

const FILTERS_KEY = 'graph.filters';
const HOLD_SEARCH = 'graph:search';
const HOLD_DRAG = 'graph:drag';

const TYPES = [
  { type: 'note', label: 'Notes', app: 'notes' },
  { type: 'task', label: 'Tasks', app: 'tasks' },
  { type: 'event', label: 'Events', app: 'calendar' },
  { type: 'post', label: 'Posts', app: 'jakestagram' },
  { type: 'video', label: 'Videos', app: 'jaketube' },
  { type: 'chat', label: 'Chats', app: 'jakegpt' },
  { type: 'habit', label: 'Habits', app: 'habits' },
  { type: 'deal', label: 'Deals', app: 'deals' },
  { type: 'person', label: 'People', app: 'people' },
  { type: 'link', label: 'Saved', app: 'saved' },
  { type: 'focus', label: 'Focus', app: 'focus' },
  { type: 'day', label: 'Days', app: null, color: '#8e8e93' },
  { type: 'tag', label: 'Tags', app: null, color: '#64d2ff' },
];
const TYPE_NAME = { note: 'Note', task: 'Task', event: 'Event', post: 'Post', video: 'Video', chat: 'Chat', habit: 'Habit', deal: 'Deal', person: 'Person', link: 'Saved link', focus: 'Focus', day: 'Day', tag: 'Tag' };
// Used only when /apps.json cannot be read (the tile colours from SPEC.md).
const FALLBACK = { notes: '#ffcc00', tasks: '#5e5ce6', calendar: '#ffffff', jakestagram: '#e1306c', jaketube: '#e62117', jakegpt: '#10a37f', habits: '#ff9f0a', graph: '#bf5af2' };
const FALLBACK_LABELS = { notes: 'Notes', tasks: 'Tasks', calendar: 'Calendar', jakestagram: 'Jakestagram', jaketube: 'JakeTube', jakegpt: 'JakeGPT', habits: 'Habits' };

// Simulation (d3-force-like units: positions in world px, velocities per tick).
const ALPHA_MIN = 0.001;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300); // ~300 ticks from 1 to ALPHA_MIN
const VELOCITY_KEEP = 0.55;                            // velocity decay 0.45
const REPEL = 58;                                      // many-body strength (times mass)
const REPEL_CELL = 110;                                // exact pairwise inside the 3x3 neighbourhood of this cell size
const MAX_GRID = 40;                                   // cells per axis cap (the cell grows instead)
const LINK_DIST = { day: 36, tag: 42, link: 46 };     // + a degree term, see linkDistance()
const LABEL_COLLIDE_MAX = 400;                         // beyond this many on-screen labels, skip the overlap pass
const GRAVITY = 0.035;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const FIT_MAX_ZOOM = 1.25;
const TICK_BUDGET_MS = 7;                              // simulation time per frame
const MAX_TICKS_PER_FRAME = 3;
const TAP_SLOP = 6;
const DOUBLE_TAP_MS = 320;
const HIT_PAD = 9;                                     // screen px around a node that still hits it
const LABEL_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif';

let S = null;       // the whole app state while mounted
let listeners = [];

export default {
  mount(root, ctx) {
    root.classList.add('full-bleed');
    S = {
      root,
      ctx,
      data: null,
      nodes: [],
      edges: [],
      byId: new Map(),
      visNodes: [],
      visEdges: [],
      colorGroups: [],
      filters: loadFilters(),
      query: '',
      matches: 0,
      sel: null,
      selAdj: null,
      hover: null,
      view: { x: 0, y: 0, k: 1 },
      autoFit: true,
      tween: null,
      alpha: 0,
      alphaTarget: 0,
      raf: 0,
      dirty: true,
      pointers: new Map(),
      gesture: null,
      lastTap: null,
      pendingSelect: ctx.sub ? ctx.sub : '',
      colors: null,
      appLabels: null,
      dark: window.matchMedia('(prefers-color-scheme: dark)'),
      reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      pal: null,
      w: 0,
      h: 0,
      dpr: 1,
      navH: 44,
      grid: null,
      stats: { tickMs: 0, frameMs: 0, drawMs: 0, ticks: 0, frames: 0, tickAvg: 0 },
      loading: false,
      loaded: false,
      els: null,
    };
    S.pal = palette(S.dark.matches);
    buildUi(root);
    listen(S.dark, 'change', onSchemeChange);
    listen(window, 'jakesdata:online', () => load());
    listen(window, 'jakesdata:foreground', () => load());
    listen(document, 'visibilitychange', () => {
      if (document.hidden) stopLoop();
      else {
        S.dirty = true;
        startLoop();
      }
    });
    // A tiny debug handle for tests and tuning: window.__jdGraph.stats / loadSynthetic(n).
    window.__jdGraph = {
      get stats() { return S ? S.stats : null; },
      get state() { return S; },
      loadSynthetic,
      setData: (data) => { if (S) { S.byId = new Map(); setData(data); } },
      nodeScreen: (id) => {
        const n = S && S.byId.get(id);
        return n ? worldToScreen(n.x, n.y) : null;
      },
      visibleNodeIds: () => (S ? S.visNodes.map((n) => n.id) : []),
    };
    loadColors().finally(() => load());
  },

  unmount() {
    stopLoop();
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
    listeners = [];
    releaseReload(HOLD_SEARCH);
    releaseReload(HOLD_DRAG);
    if (S && S.ro) S.ro.disconnect();
    if (window.__jdGraph) delete window.__jdGraph;
    S = null;
  },

  route(sub) {
    if (!S) return;
    const id = sub ? String(sub) : '';
    if (!id) {
      if (S.sel) deselect(false);
      return;
    }
    if (S.sel && S.sel.id === id) return;
    if (!S.loaded) {
      S.pendingSelect = id;
      return;
    }
    openNodeById(id);
  },
};

function listen(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  listeners.push([target, type, fn, opts]);
}

// ---------------------------------------------------------------- UI

function buildUi(root) {
  const filterBtn = navButton({ icon: 'search', label: 'Filter and search', onClick: openSheet });
  const bar = navbar({ title: 'Graph', right: [filterBtn] });

  const canvas = el('canvas', { class: 'gcanvas', 'aria-label': 'Graph of your data', role: 'img' });
  const stats = el('span', { class: 'gstats', text: '' });
  const searchPill = el('button', {
    class: 'gpill', type: 'button', hidden: true, 'aria-label': 'Clear search',
    'on:click': () => setQuery(''),
  }, el('span', { class: 'gpill-text' }), icon('close', { size: 16, strokeWidth: 2.4 }));
  const fitBtn = el('button', { class: 'gfit', type: 'button', text: 'Fit', 'on:click': () => fitView(true) });
  const info = el('div', { class: 'ginfo' }, el('div', { class: 'ginfo-left' }, stats, searchPill), fitBtn);

  const empty = emptyState('Nothing to connect yet — add some notes, tasks or posts.');
  empty.classList.add('gempty');
  empty.hidden = true;
  const showAll = el('button', { class: 'gshowall', type: 'button', text: 'Show all', 'on:click': () => setFilters(allOn()) });
  const noMatch = el('div', { class: 'gempty gnomatch', hidden: true }, el('p', { class: 'empty', text: 'Nothing matches these filters.' }), showAll);

  // Selection card
  const cardDot = el('span', { class: 'gdot' });
  const cardThumb = el('img', { class: 'gthumb', alt: '', hidden: true });
  const cardTitle = el('div', { class: 'gcard-title' });
  const cardMeta = el('div', { class: 'gcard-meta' });
  const cardClose = el('button', { class: 'gcard-close', type: 'button', 'aria-label': 'Close', 'on:click': () => deselect(true) }, icon('close', { size: 20 }));
  const openBtn = el('button', { class: 'gcard-open', type: 'button', text: 'Open', 'on:click': openSelected });
  const centreBtn = el('button', { class: 'gcard-centre', type: 'button', text: 'Centre', 'on:click': () => { if (S.sel) centreOn(S.sel, true); } });
  const card = el('div', { class: 'gcard', hidden: true, role: 'dialog', 'aria-label': 'Selected node' },
    el('div', { class: 'gcard-head' }, cardThumb, cardDot, el('div', { class: 'gcard-text' }, cardTitle, cardMeta), cardClose),
    el('div', { class: 'gcard-actions' }, openBtn, centreBtn));

  const sheet = buildSheet();

  const stage = el('div', { class: 'app-content gstage' }, canvas, info, empty, noMatch, card, sheet.host);
  root.append(bar, stage);

  S.els = { bar, canvas, stage, info, stats, searchPill, fitBtn, empty, noMatch, card, cardDot, cardThumb, cardTitle, cardMeta, openBtn, centreBtn, ...sheet };
  S.g = canvas.getContext('2d', { alpha: false });

  // Size: the stage fills the window; the canvas follows it (devicePixelRatio aware).
  S.ro = new ResizeObserver(() => resize());
  S.ro.observe(stage);
  resize();

  listen(canvas, 'pointerdown', onPointerDown);
  listen(canvas, 'pointermove', onPointerMove);
  listen(canvas, 'pointerup', onPointerUp);
  listen(canvas, 'pointercancel', onPointerUp);
  listen(canvas, 'pointerleave', onPointerLeave);
  listen(canvas, 'wheel', onWheel, { passive: false });
  listen(canvas, 'contextmenu', (e) => e.preventDefault());
  // WKWebView: touch-action alone does not stop the native page pinch/scroll; these do.
  const swallow = (e) => { if (e.cancelable) e.preventDefault(); };
  listen(canvas, 'touchstart', swallow, { passive: false });
  listen(canvas, 'touchmove', swallow, { passive: false });
  listen(canvas, 'gesturestart', swallow, { passive: false });
}

function buildSheet() {
  const input = el('input', {
    class: 'input gsearch-input', type: 'search', placeholder: 'Search labels', 'aria-label': 'Search labels',
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'search',
  });
  const count = el('span', { class: 'gsearch-count', text: '' });
  const onInput = debounce(() => setQuery(input.value), 120);
  input.addEventListener('input', onInput);
  input.addEventListener('focus', () => holdReload(HOLD_SEARCH));
  input.addEventListener('blur', () => releaseReload(HOLD_SEARCH));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      onInput.flush();
      input.blur();
    }
  });

  const rows = new Map();
  const list = el('div', { class: 'gsheet-group gtypes' });
  for (const t of TYPES) {
    const dot = el('span', { class: 'gdot' });
    const num = el('span', { class: 'gcount', text: '' });
    const sw = el('button', { class: 'gswitch', type: 'button', role: 'switch', 'aria-checked': 'true', 'aria-label': t.label }, el('span', { class: 'gknob' }));
    const row = el('div', { class: 'grow' }, dot, el('span', { class: 'glabel', text: t.label }), num, sw);
    sw.addEventListener('click', () => {
      haptic('light');
      const next = { ...S.filters, [t.type]: !S.filters[t.type] };
      setFilters(next);
    });
    rows.set(t.type, { row, dot, num, sw });
    list.append(row);
  }
  const allBtn = el('button', { class: 'gsheet-link', type: 'button', text: 'Show all', 'on:click': () => setFilters(allOn()) });
  const head = el('div', { class: 'gsheet-head' }, el('span', { class: 'gsheet-title', text: 'Show' }), allBtn);
  const done = el('button', { class: 'gsheet-done', type: 'button', text: 'Done', 'on:click': closeSheet });
  const backdrop = el('div', { class: 'gsheet-backdrop', 'on:click': closeSheet });
  const panel = el('div', { class: 'gsheet-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Filter and search' },
    el('div', { class: 'gsheet-group gsearch' }, input, count),
    el('div', { class: 'gsheet-group' }, head, list),
    el('div', { class: 'gsheet-group' }, done));
  const host = el('div', { class: 'gsheet', hidden: true }, backdrop, panel);
  return { host, sheetPanel: panel, sheetBackdrop: backdrop, searchInput: input, searchCount: count, typeRows: rows };
}

function openSheet() {
  const { host, sheetPanel, sheetBackdrop, searchInput } = S.els;
  haptic('light');
  sheetPanel.classList.remove('out');
  sheetBackdrop.classList.remove('out');
  host.hidden = false;
  searchInput.value = S.query;
  syncSheet();
  if (window.matchMedia('(hover: hover)').matches) searchInput.focus();
}

function closeSheet() {
  const { host, sheetPanel, sheetBackdrop, searchInput } = S.els;
  if (host.hidden) return;
  searchInput.blur();
  sheetPanel.classList.add('out');
  sheetBackdrop.classList.add('out');
  setTimeout(() => {
    if (S && S.els) S.els.host.hidden = true;
  }, 170);
}

function syncSheet() {
  if (!S || !S.els) return;
  const counts = (S.data && S.data.counts) || {};
  for (const t of TYPES) {
    const r = S.els.typeRows.get(t.type);
    const on = S.filters[t.type] !== false;
    r.sw.setAttribute('aria-checked', String(on));
    r.row.classList.toggle('off', !on);
    r.dot.style.background = colorForType(t.type);
    const n = counts[t.type] || 0;
    r.num.textContent = n ? String(n) : '';
  }
  S.els.searchCount.textContent = S.query ? `${S.matches} ${S.matches === 1 ? 'match' : 'matches'}` : '';
}

function syncInfo() {
  const { stats, searchPill, empty, noMatch, fitBtn } = S.els;
  const n = S.visNodes.length;
  const e = S.visEdges.length;
  const parts = [`${n} ${n === 1 ? 'node' : 'nodes'}`, `${e} ${e === 1 ? 'edge' : 'edges'}`];
  if (S.data && S.data.truncated) parts.push('newest only');
  stats.textContent = parts.join(' · ');
  stats.hidden = Boolean(S.query);
  searchPill.hidden = !S.query;
  if (S.query) searchPill.querySelector('.gpill-text').textContent = `“${S.query}” · ${S.matches} ${S.matches === 1 ? 'match' : 'matches'}`;
  const total = S.nodes.length;
  empty.hidden = !(S.loaded && total < 2);
  noMatch.hidden = !(S.loaded && total >= 2 && n === 0);
  fitBtn.hidden = n < 2;
  S.els.info.hidden = S.loaded && total < 2;
}

// ---------------------------------------------------------------- data

async function loadColors() {
  try {
    const res = await fetch('/apps.json', { cache: 'no-store' });
    const data = await res.json();
    const apps = data && data.apps && typeof data.apps === 'object' ? data.apps : {};
    const colors = {};
    const labels = {};
    for (const [id, meta] of Object.entries(apps)) {
      if (meta && typeof meta.color === 'string') colors[id] = meta.color;
      if (meta && typeof meta.label === 'string') labels[id] = meta.label;
    }
    if (S) {
      S.colors = { ...FALLBACK, ...colors };
      S.appLabels = { ...FALLBACK_LABELS, ...labels };
    }
  } catch {
    if (S) {
      S.colors = { ...FALLBACK };
      S.appLabels = { ...FALLBACK_LABELS };
    }
  }
}

async function load(refresh = false) {
  if (!S || S.loading) return;
  S.loading = true;
  try {
    const data = await api(refresh ? '/api/graph?refresh=1' : '/api/graph', { timeout: 15000 });
    if (!S) return;
    setData(data);
  } catch (err) {
    if (!S) return;
    if (!S.loaded) {
      S.els.stats.textContent = err && err.status ? `Couldn't load the graph: ${err.message}` : "Can't reach the PC";
    }
  } finally {
    if (S) S.loading = false;
  }
}

// Builds the simulation nodes from the API payload, keeping the positions of nodes that
// were already on screen (a refetch must not reshuffle the picture).
function setData(data) {
  const rawNodes = Array.isArray(data && data.nodes) ? data.nodes : [];
  const rawEdges = Array.isArray(data && data.edges) ? data.edges : [];
  const prev = S.byId;
  const byId = new Map();
  const nodes = [];
  for (const raw of rawNodes) {
    if (!raw || typeof raw.id !== 'string' || byId.has(raw.id)) continue;
    const old = prev.get(raw.id);
    const node = {
      id: raw.id,
      type: TYPE_NAME[raw.type] ? raw.type : 'note',
      label: String(raw.label == null ? '' : raw.label),
      lower: String(raw.label == null ? '' : raw.label).toLowerCase(),
      app: raw.app || null,
      route: typeof raw.route === 'string' ? raw.route : null,
      date: raw.date || null,
      meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
      x: old ? old.x : 0,
      y: old ? old.y : 0,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
      placed: Boolean(old),
      deg: 0,
      r: 4,
      m: 1,
      color: '#8e8e93',
      adj: [],
      idx: 0,
      vis: true,
      match: false,
      text: null,
      lw: null,
    };
    byId.set(node.id, node);
    nodes.push(node);
  }
  const edges = [];
  const seen = new Set();
  for (const raw of rawEdges) {
    if (!raw) continue;
    const a = byId.get(raw.source);
    const b = byId.get(raw.target);
    if (!a || !b || a === b) continue;
    const key = `${a.id}\n${b.id}`;
    if (seen.has(key) || seen.has(`${b.id}\n${a.id}`)) continue;
    seen.add(key);
    const kind = raw.kind === 'tag' || raw.kind === 'link' ? raw.kind : 'day';
    edges.push({ a, b, kind, vis: true });
    a.deg += 1;
    b.deg += 1;
  }
  nodes.forEach((n, i) => { n.idx = i; });
  for (const e of edges) {
    e.a.adj.push(e.b.idx);
    e.b.adj.push(e.a.idx);
    e.dist = linkDistance(e);
  }
  for (const n of nodes) {
    n.r = 4 + Math.min(10, 1.7 * Math.sqrt(Math.max(0, n.deg - 1)));
    n.m = 0.55 + n.r / 7;
  }
  // Initial positions: a phyllotaxis spiral for the whole set the first time, and new nodes
  // next to an already-placed neighbour afterwards.
  const firstTime = prev.size === 0;
  const spiral = (i) => {
    const radius = 9 * Math.sqrt(0.5 + i);
    const angle = i * 2.399963229728653;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  };
  nodes.forEach((n, i) => {
    if (n.placed) return;
    if (!firstTime) {
      const buddy = n.adj.map((j) => nodes[j]).find((o) => o.placed);
      if (buddy) {
        const a = Math.random() * Math.PI * 2;
        n.x = buddy.x + Math.cos(a) * 20;
        n.y = buddy.y + Math.sin(a) * 20;
        n.placed = true;
        return;
      }
    }
    const p = spiral(i);
    n.x = p.x;
    n.y = p.y;
    n.placed = true;
  });
  S.data = data;
  S.nodes = nodes;
  S.edges = edges;
  S.byId = byId;
  S.loaded = true;
  if (S.sel) S.sel = byId.get(S.sel.id) || null;
  if (S.hover) S.hover = byId.get(S.hover.id) || null;
  recolor();
  applyFilters(firstTime ? 1 : 0.4);
  if (firstTime) {
    S.autoFit = true;
    fitView(false);
  }
  if (S.pendingSelect) {
    const id = S.pendingSelect;
    S.pendingSelect = '';
    openNodeById(id);
  } else if (S.sel) {
    select(S.sel, false);
  }
}

// The world + edges that are visible under the current filters; rebuilds the colour groups,
// matches and the stats line, then re-heats the simulation.
function applyFilters(reheat = 0.3) {
  const f = S.filters;
  for (const n of S.nodes) n.vis = f[n.type] !== false;
  S.visNodes = S.nodes.filter((n) => n.vis);
  S.visEdges = S.edges.filter((e) => {
    e.vis = e.a.vis && e.b.vis;
    return e.vis;
  });
  const groups = new Map();
  for (const n of S.visNodes) {
    if (!groups.has(n.color)) groups.set(n.color, []);
    groups.get(n.color).push(n);
  }
  S.colorGroups = [...groups.entries()].map(([color, list]) => ({ color, list }));
  applyQuery();
  if (S.sel && !S.sel.vis) deselect(false);
  syncInfo();
  syncSheet();
  if (reheat > 0) startSim(reheat);
  S.dirty = true;
  startLoop();
}

function applyQuery() {
  const q = S.query.trim().toLowerCase();
  let count = 0;
  for (const n of S.nodes) {
    n.match = Boolean(q) && n.vis && n.lower.includes(q);
    if (n.match) count += 1;
  }
  S.matches = count;
}

function setQuery(value) {
  if (!S) return;
  const q = String(value == null ? '' : value).trim();
  if (q === S.query) return;
  S.query = q;
  if (S.els.searchInput.value !== q && document.activeElement !== S.els.searchInput) S.els.searchInput.value = q;
  applyQuery();
  syncInfo();
  syncSheet();
  S.dirty = true;
  startLoop();
}

function loadFilters() {
  const saved = store.get(FILTERS_KEY, null);
  const out = allOn();
  if (saved && typeof saved === 'object') {
    for (const t of TYPES) if (saved[t.type] === false) out[t.type] = false;
  }
  return out;
}

function allOn() {
  const out = {};
  for (const t of TYPES) out[t.type] = true;
  return out;
}

function setFilters(next) {
  S.filters = { ...allOn(), ...next };
  store.set(FILTERS_KEY, S.filters);
  applyFilters(0.35);
}

function colorForType(type, app) {
  const t = TYPES.find((x) => x.type === type);
  if (t && t.color) return t.color;
  const colors = S.colors || FALLBACK;
  const id = app || (t && t.app) || null;
  let c = (id && colors[id]) || '#8e8e93';
  // The calendar tile is white in light mode and #1c1c1e in dark mode (like the iOS tile);
  // on the light canvas a white dot would vanish, so use the dark-tile colour there.
  if (!S.dark.matches && isNearWhite(c)) c = '#1c1c1e';
  return c;
}

function isNearWhite(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return false;
  const v = parseInt(m[1], 16);
  return ((v >> 16) & 255) > 235 && ((v >> 8) & 255) > 235 && (v & 255) > 235;
}

function recolor() {
  for (const n of S.nodes) n.color = colorForType(n.type, n.app);
}

function onSchemeChange() {
  if (!S) return;
  S.pal = palette(S.dark.matches);
  recolor();
  applyFilters(0);
  if (S.sel) renderCard(S.sel);
}

function palette(dark) {
  return dark
    ? { bg: '#161616', edge: 'rgba(255,255,255,0.11)', edgeHi: 'rgba(255,255,255,0.55)', edgeDim: 'rgba(255,255,255,0.03)', label: 'rgba(242,242,247,0.8)', labelHi: '#ffffff', halo: '#161616', ring: '#ffffff', match: '#ffd60a', nodeDim: 0.16 }
    : { bg: '#f2f2f7', edge: 'rgba(0,0,0,0.14)', edgeHi: 'rgba(0,0,0,0.6)', edgeDim: 'rgba(0,0,0,0.035)', label: 'rgba(28,28,30,0.82)', labelHi: '#1c1c1e', halo: '#f2f2f7', ring: '#1c1c1e', match: '#ff9f0a', nodeDim: 0.18 };
}

// ---------------------------------------------------------------- simulation

function startSim(alpha) {
  S.alpha = Math.max(S.alpha, Math.min(1, alpha));
  startLoop();
}

function startLoop() {
  if (!S || S.raf || document.hidden) return;
  S.raf = requestAnimationFrame(frame);
}

function stopLoop() {
  if (S && S.raf) {
    cancelAnimationFrame(S.raf);
    S.raf = 0;
  }
}

function frame(now) {
  if (!S) return;
  S.raf = 0;
  const t0 = performance.now();
  let ticks = 0;
  while ((S.alpha > ALPHA_MIN || S.alphaTarget > 0) && ticks < MAX_TICKS_PER_FRAME && performance.now() - t0 < TICK_BUDGET_MS) {
    tick();
    ticks += 1;
  }
  const t1 = performance.now();
  if (ticks) {
    S.stats.tickMs = (t1 - t0) / ticks;
    S.stats.ticks += ticks;
    S.stats.tickAvg = S.stats.tickAvg ? S.stats.tickAvg * 0.9 + S.stats.tickMs * 0.1 : S.stats.tickMs;
    if (S.autoFit) fitView(false, 0.2);
    S.dirty = true;
  }
  if (S.tween) stepTween(now);
  if (S.dirty) {
    draw();
    S.dirty = false;
  }
  const t2 = performance.now();
  S.stats.drawMs = t2 - t1;
  S.stats.frameMs = t2 - t0;
  S.stats.frames += 1;
  if (S.alpha > ALPHA_MIN || S.alphaTarget > 0 || S.tween) S.raf = requestAnimationFrame(frame);
}

function tick() {
  const alpha = S.alpha;
  const vis = S.visNodes;
  repel(vis, alpha);
  // Springs (d3 link force: strength 1/min(deg), bias toward the lighter end).
  for (const e of S.visEdges) {
    const a = e.a;
    const b = e.b;
    let dx = b.x + b.vx - a.x - a.vx;
    let dy = b.y + b.vy - a.y - a.vy;
    if (dx === 0 && dy === 0) {
      dx = (Math.random() - 0.5) * 1e-3;
      dy = (Math.random() - 0.5) * 1e-3;
    }
    const l = Math.sqrt(dx * dx + dy * dy);
    const strength = 1 / Math.min(a.deg || 1, b.deg || 1);
    const f = ((l - e.dist) / l) * alpha * strength;
    dx *= f;
    dy *= f;
    const bias = a.deg / (a.deg + b.deg || 1);
    b.vx -= dx * bias;
    b.vy -= dy * bias;
    a.vx += dx * (1 - bias);
    a.vy += dy * (1 - bias);
  }
  // Centre gravity + integration.
  for (const n of vis) {
    if (n.fx != null) {
      n.x = n.fx;
      n.y = n.fy;
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx -= n.x * GRAVITY * alpha;
    n.vy -= n.y * GRAVITY * alpha;
    n.vx *= VELOCITY_KEEP;
    n.vy *= VELOCITY_KEEP;
    n.x += n.vx;
    n.y += n.vy;
  }
  S.alpha += (S.alphaTarget - S.alpha) * ALPHA_DECAY;
}

// Hubs with many links get longer springs so a day with 12 items (or a habit with 40
// check-in days) opens into a star instead of a knot.
function linkDistance(e) {
  return LINK_DIST[e.kind] + 2.6 * Math.sqrt(e.a.deg * e.b.deg);
}

// Many-body repulsion through a uniform grid: nodes are counting-sorted into cells; pairs
// inside the 3x3 neighbourhood interact exactly, every other cell acts through its centroid
// and mass. Buffers are reused between ticks.
function repel(vis, alpha) {
  const n = vis.length;
  if (n < 2) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = vis[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const cell = Math.max(REPEL_CELL, w / MAX_GRID, h / MAX_GRID);
  const cols = Math.floor(w / cell) + 1;
  const rows = Math.floor(h / cell) + 1;
  const C = cols * rows;
  let g = S.grid;
  if (!g || g.cap < n || g.cells < C) {
    const cap = Math.max(n, g ? g.cap : 0) + 64;
    const cells = Math.max(C, g ? g.cells : 0) + 64;
    g = S.grid = {
      cap, cells,
      cellOf: new Int32Array(cap), order: new Int32Array(cap),
      start: new Int32Array(cells + 1), fill: new Int32Array(cells + 1),
      cx: new Float64Array(cells), cy: new Float64Array(cells), mass: new Float64Array(cells),
      nonEmpty: new Int32Array(cells),
    };
  }
  const { cellOf, order, start, fill, cx, cy, mass, nonEmpty } = g;
  start.fill(0, 0, C + 1);
  for (let i = 0; i < n; i++) {
    const p = vis[i];
    const c = Math.floor((p.x - minX) / cell) + Math.floor((p.y - minY) / cell) * cols;
    cellOf[i] = c;
    start[c + 1] += 1;
  }
  for (let c = 0; c < C; c++) start[c + 1] += start[c];
  fill.set(start.subarray(0, C + 1));
  for (let i = 0; i < n; i++) order[fill[cellOf[i]]++] = i;
  let ne = 0;
  for (let c = 0; c < C; c++) {
    const s = start[c];
    const e = start[c + 1];
    if (s === e) continue;
    let sx = 0;
    let sy = 0;
    let sm = 0;
    for (let k = s; k < e; k++) {
      const p = vis[order[k]];
      sx += p.x * p.m;
      sy += p.y * p.m;
      sm += p.m;
    }
    cx[c] = sx / sm;
    cy[c] = sy / sm;
    mass[c] = sm;
    nonEmpty[ne++] = c;
  }
  const K = REPEL * alpha;
  // Near field: pairs inside a cell and with the four "forward" neighbour cells.
  for (let q = 0; q < ne; q++) {
    const c = nonEmpty[q];
    const col = c % cols;
    const row = (c - col) / cols;
    const s = start[c];
    const e = start[c + 1];
    for (let i = s; i < e; i++) {
      const a = vis[order[i]];
      for (let j = i + 1; j < e; j++) pair(a, vis[order[j]], K);
    }
    const right = col + 1 < cols;
    const down = row + 1 < rows;
    if (right) pairCells(vis, order, start, c + 1, s, e, K);
    if (down) {
      if (col > 0) pairCells(vis, order, start, c + cols - 1, s, e, K);
      pairCells(vis, order, start, c + cols, s, e, K);
      if (right) pairCells(vis, order, start, c + cols + 1, s, e, K);
    }
  }
  // Far field: every other non-empty cell through its centroid.
  for (let i = 0; i < n; i++) {
    const p = vis[i];
    const c = cellOf[i];
    const col = c % cols;
    const row = (c - col) / cols;
    let fx = 0;
    let fy = 0;
    for (let q = 0; q < ne; q++) {
      const o = nonEmpty[q];
      const ocol = o % cols;
      const orow = (o - ocol) / cols;
      if (ocol >= col - 1 && ocol <= col + 1 && orow >= row - 1 && orow <= row + 1) continue;
      const dx = p.x - cx[o];
      const dy = p.y - cy[o];
      const d2 = dx * dx + dy * dy;
      const f = (K * mass[o]) / d2;
      fx += dx * f;
      fy += dy * f;
    }
    p.vx += fx;
    p.vy += fy;
  }
}

function pairCells(vis, order, start, c2, s, e, K) {
  const s2 = start[c2];
  const e2 = start[c2 + 1];
  if (s2 === e2) return;
  for (let i = s; i < e; i++) {
    const a = vis[order[i]];
    for (let j = s2; j < e2; j++) pair(a, vis[order[j]], K);
  }
}

function pair(a, b, K) {
  let dx = a.x - b.x;
  let dy = a.y - b.y;
  let d2 = dx * dx + dy * dy;
  if (d2 < 1) {
    dx = (Math.random() - 0.5) || 0.5;
    dy = (Math.random() - 0.5) || 0.5;
    d2 = dx * dx + dy * dy;
  }
  const f = K / d2;
  a.vx += dx * f * b.m;
  a.vy += dy * f * b.m;
  b.vx -= dx * f * a.m;
  b.vy -= dy * f * a.m;
}

// ---------------------------------------------------------------- view

// Layout size (clientWidth/Height), not getBoundingClientRect(): while the launcher's open
// animation scales the #app layer, the bounding rect is tiny and would size the canvas wrong.
function resize() {
  if (!S) return;
  const stage = S.els.stage;
  const w = Math.max(1, stage.clientWidth || Math.round(stage.getBoundingClientRect().width));
  const h = Math.max(1, stage.clientHeight || Math.round(stage.getBoundingClientRect().height));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  S.navH = navHeight();
  if (w === S.w && h === S.h && dpr === S.dpr) return;
  S.w = w;
  S.h = h;
  S.dpr = dpr;
  S.els.canvas.width = Math.round(w * dpr);
  S.els.canvas.height = Math.round(h * dpr);
  S.els.canvas.style.width = `${w}px`;
  S.els.canvas.style.height = `${h}px`;
  if (S.autoFit && S.visNodes.length) fitView(false);
  S.dirty = true;
  startLoop();
}

function navHeight() {
  return S.els.bar.offsetHeight || 44;
}

function worldToScreen(x, y) {
  return { x: x * S.view.k + S.view.x, y: y * S.view.k + S.view.y };
}

function screenToWorld(sx, sy) {
  return { x: (sx - S.view.x) / S.view.k, y: (sy - S.view.y) / S.view.k };
}

function clientToCanvas(cx, cy) {
  const r = S.els.canvas.getBoundingClientRect();
  return { x: cx - r.left, y: cy - r.top };
}

function clampZoom(k) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

function zoomAt(sx, sy, factor) {
  const k = clampZoom(S.view.k * factor);
  const f = k / S.view.k;
  S.view.x = sx - (sx - S.view.x) * f;
  S.view.y = sy - (sy - S.view.y) * f;
  S.view.k = k;
  S.autoFit = false;
  S.tween = null;
  S.dirty = true;
  startLoop();
}

// The view that shows every visible node (cap FIT_MAX_ZOOM so three nodes are not huge).
function fitTarget() {
  const vis = S.visNodes;
  if (!vis.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of vis) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  const pad = 36;
  const top = S.navH + 30;
  const bottom = (S.sel ? 150 : 24) + safeBottom();
  const availW = Math.max(50, S.w - pad * 2);
  const availH = Math.max(50, S.h - top - bottom);
  const w = Math.max(40, maxX - minX + 20);
  const h = Math.max(40, maxY - minY + 20);
  const k = Math.min(FIT_MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(availW / w, availH / h)));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { k, x: S.w / 2 - cx * k, y: top + availH / 2 - cy * k };
}

function safeBottom() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--sab');
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function fitView(animate, lerp = 1) {
  const target = fitTarget();
  if (!target) return;
  if (animate) {
    S.autoFit = false;
    tweenTo(target);
    return;
  }
  if (lerp >= 1) {
    S.view = target;
  } else {
    S.view.x += (target.x - S.view.x) * lerp;
    S.view.y += (target.y - S.view.y) * lerp;
    S.view.k += (target.k - S.view.k) * lerp;
  }
  S.dirty = true;
}

function centreOn(node, animate) {
  const k = clampZoom(Math.max(S.view.k, 1.6));
  const top = S.navH;
  const bottom = 150 + safeBottom();
  const target = { k, x: S.w / 2 - node.x * k, y: top + (S.h - top - bottom) / 2 - node.y * k };
  S.autoFit = false;
  if (animate && !S.reduced) tweenTo(target);
  else {
    S.view = target;
    S.tween = null;
    S.dirty = true;
    startLoop();
  }
}

function tweenTo(target) {
  if (S.reduced) {
    S.view = { ...target };
    S.tween = null;
    S.dirty = true;
    startLoop();
    return;
  }
  S.tween = { from: { ...S.view }, to: { ...target }, t0: performance.now(), dur: 280 };
  startLoop();
}

function stepTween(now) {
  const t = S.tween;
  const p = Math.min(1, (now - t.t0) / t.dur);
  const e = 1 - Math.pow(1 - p, 3);
  S.view.x = t.from.x + (t.to.x - t.from.x) * e;
  S.view.y = t.from.y + (t.to.y - t.from.y) * e;
  S.view.k = t.from.k + (t.to.k - t.from.k) * e;
  S.dirty = true;
  if (p >= 1) S.tween = null;
}

// ---------------------------------------------------------------- drawing

function draw() {
  const g = S.g;
  const { w, h, dpr, pal, view } = S;
  const k = view.k;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = pal.bg;
  g.fillRect(0, 0, w * dpr, h * dpr);
  if (!S.visNodes.length) return;
  g.setTransform(dpr * k, 0, 0, dpr * k, dpr * view.x, dpr * view.y);

  const sel = S.sel;
  const adj = S.selAdj;
  const hover = S.hover;
  const searching = Boolean(S.query);
  const dimming = Boolean(sel) || searching;
  const isLit = (n) => (sel ? n === sel || adj.has(n.idx) : n.match);
  // Culling bounds in world units.
  const wx0 = -view.x / k - 40;
  const wy0 = -view.y / k - 40;
  const wx1 = (w - view.x) / k + 40;
  const wy1 = (h - view.y) / k + 40;
  const onScreen = (n) => n.x >= wx0 && n.x <= wx1 && n.y >= wy0 && n.y <= wy1;

  // Edges: one path for the plain ones, one for the highlighted ones.
  g.lineWidth = Math.max(0.6, 1 / k);
  g.lineCap = 'round';
  g.strokeStyle = dimming ? pal.edgeDim : pal.edge;
  g.beginPath();
  let lit = null;
  for (const e of S.visEdges) {
    const a = e.a;
    const b = e.b;
    if (!onScreen(a) && !onScreen(b)) continue;
    if (dimming && (sel ? (a === sel || b === sel) : (a.match && b.match))) {
      if (!lit) lit = [];
      lit.push(e);
      continue;
    }
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
  }
  g.stroke();
  if (lit) {
    g.strokeStyle = pal.edgeHi;
    g.lineWidth = Math.max(0.8, 1.4 / k);
    g.beginPath();
    for (const e of lit) {
      g.moveTo(e.a.x, e.a.y);
      g.lineTo(e.b.x, e.b.y);
    }
    g.stroke();
  }

  // Nodes grouped by colour, bright then dimmed.
  const minR = 1.6 / k;
  const TAU = Math.PI * 2;
  for (const { color, list } of S.colorGroups) {
    g.fillStyle = color;
    g.beginPath();
    let dimList = null;
    for (const n of list) {
      if (!onScreen(n)) continue;
      if (dimming && !isLit(n)) {
        if (!dimList) dimList = [];
        dimList.push(n);
        continue;
      }
      const r = Math.max(minR, n.r);
      g.moveTo(n.x + r, n.y);
      g.arc(n.x, n.y, r, 0, TAU);
    }
    g.fill();
    if (dimList) {
      g.globalAlpha = pal.nodeDim;
      g.beginPath();
      for (const n of dimList) {
        const r = Math.max(minR, n.r);
        g.moveTo(n.x + r, n.y);
        g.arc(n.x, n.y, r, 0, TAU);
      }
      g.fill();
      g.globalAlpha = 1;
    }
  }

  // Rings: search matches, hover, selection.
  if (searching) {
    g.strokeStyle = pal.match;
    g.lineWidth = 2 / k;
    g.beginPath();
    for (const n of S.visNodes) {
      if (!n.match || !onScreen(n)) continue;
      const r = Math.max(minR, n.r) + 3 / k;
      g.moveTo(n.x + r, n.y);
      g.arc(n.x, n.y, r, 0, TAU);
    }
    g.stroke();
  }
  if (hover && hover.vis && hover !== sel) {
    g.strokeStyle = pal.ring;
    g.lineWidth = 1.5 / k;
    g.beginPath();
    const r = Math.max(minR, hover.r) + 2.5 / k;
    g.arc(hover.x, hover.y, r, 0, TAU);
    g.stroke();
  }
  if (sel && sel.vis) {
    g.strokeStyle = pal.ring;
    g.lineWidth = 2.5 / k;
    g.beginPath();
    const r = Math.max(minR, sel.r) + 3.5 / k;
    g.arc(sel.x, sel.y, r, 0, TAU);
    g.stroke();
  }

  // Labels in screen space (constant size): selected + neighbours + hover + matches always;
  // everything at zoom >= 1.6 (day/tag hubs at >= 1.0), fading in over a short band.
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.lineJoin = 'round';
  g.lineWidth = 3;
  g.strokeStyle = pal.halo;
  const hubA = Math.min(1, Math.max(0, (k - 0.9) / 0.2));
  const itemA = Math.min(1, Math.max(0, (k - 1.45) / 0.25));
  // Collect the candidates (selected first, then hover, neighbours, matches, then the rest)
  // and skip any label whose box overlaps one already placed.
  const wanted = [];
  for (const n of S.visNodes) {
    if (!onScreen(n)) continue;
    let a;
    let pri;
    if (n === sel) { a = 1; pri = 0; } else if (n === hover) { a = 1; pri = 1; } else if ((sel && adj.has(n.idx)) || n.match) { a = 1; pri = 2; } else {
      const hub = n.type === 'day' || n.type === 'tag';
      a = hub ? hubA : itemA;
      if (a <= 0) continue;
      if (dimming) a *= 0.3;
      pri = hub ? 3 : 4;
    }
    const p = worldToScreen(n.x, n.y);
    if (p.x < -200 || p.x > w + 200 || p.y < -40 || p.y > h + 40) continue;
    wanted.push({ n, a, pri, x: p.x, y: p.y + Math.max(minR, n.r) * k + 4 });
  }
  wanted.sort((u, v) => u.pri - v.pri || v.n.deg - u.n.deg);
  const placed = [];
  const collide = wanted.length <= LABEL_COLLIDE_MAX;
  let font = '';
  for (const item of wanted) {
    const n = item.n;
    const hub = n.type === 'day' || n.type === 'tag';
    const wantFont = hub ? `600 11px ${LABEL_FONT}` : `11px ${LABEL_FONT}`;
    if (wantFont !== font) {
      font = wantFont;
      g.font = font;
    }
    if (n.lw == null) n.lw = g.measureText(n.text || (n.text = n.label.length > 36 ? `${n.label.slice(0, 35)}…` : n.label)).width;
    const x0 = item.x - n.lw / 2 - 3;
    const x1 = item.x + n.lw / 2 + 3;
    const y0 = item.y - 1;
    const y1 = item.y + 14;
    if (collide) {
      let hit = false;
      for (const b of placed) {
        if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) { hit = true; break; }
      }
      if (hit && item.pri > 0) continue;
      placed.push([x0, y0, x1, y1]);
    }
    g.globalAlpha = item.a;
    g.strokeText(n.text, item.x, item.y);
    g.fillStyle = n === sel || n === hover ? pal.labelHi : pal.label;
    g.fillText(n.text, item.x, item.y);
  }
  g.globalAlpha = 1;
}

// ---------------------------------------------------------------- pointer input

function nodeAt(cx, cy) {
  const p = clientToCanvas(cx, cy);
  const k = S.view.k;
  let best = null;
  let bestD = Infinity;
  for (const n of S.visNodes) {
    const sx = n.x * k + S.view.x;
    const sy = n.y * k + S.view.y;
    const dx = sx - p.x;
    const dy = sy - p.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const hit = Math.max(n.r * k, 6) + HIT_PAD;
    if (d <= hit && d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

function onPointerDown(e) {
  if (!S || !S.loaded) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const canvas = S.els.canvas;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  e.preventDefault();
  S.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
  if (S.pointers.size === 1) {
    const node = nodeAt(e.clientX, e.clientY);
    S.gesture = { kind: node ? 'node' : 'pan', node, moved: false, startX: e.clientX, startY: e.clientY, view0: { ...S.view }, pointerType: e.pointerType };
    if (!node) canvas.classList.add('panning');
  } else if (S.pointers.size === 2) {
    if (S.gesture && S.gesture.kind === 'node' && S.gesture.moved) endDrag(S.gesture.node);
    const [a, b] = [...S.pointers.values()];
    S.gesture = { kind: 'pinch', a0: { x: a.x, y: a.y }, b0: { x: b.x, y: b.y }, view0: { ...S.view }, moved: true };
    S.autoFit = false;
    S.tween = null;
  }
}

function onPointerMove(e) {
  if (!S) return;
  const p = S.pointers.get(e.pointerId);
  if (!p) {
    if (e.pointerType === 'mouse') updateHover(e);
    return;
  }
  p.x = e.clientX;
  p.y = e.clientY;
  const g = S.gesture;
  if (!g) return;
  if (g.kind === 'pinch') {
    const pts = [...S.pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const d0 = Math.hypot(g.b0.x - g.a0.x, g.b0.y - g.a0.y) || 1;
    const d1 = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const k = clampZoom(g.view0.k * (d1 / d0));
    const m0 = clientToCanvas((g.a0.x + g.b0.x) / 2, (g.a0.y + g.b0.y) / 2);
    const m1 = clientToCanvas((a.x + b.x) / 2, (a.y + b.y) / 2);
    const wx = (m0.x - g.view0.x) / g.view0.k;
    const wy = (m0.y - g.view0.y) / g.view0.k;
    S.view = { k, x: m1.x - wx * k, y: m1.y - wy * k };
    S.dirty = true;
    startLoop();
    return;
  }
  const dx = e.clientX - g.startX;
  const dy = e.clientY - g.startY;
  if (!g.moved) {
    if (Math.hypot(dx, dy) < TAP_SLOP) return;
    g.moved = true;
    S.autoFit = false;
    S.tween = null;
    if (g.kind === 'node') beginDrag(g.node);
  }
  if (g.kind === 'node') {
    const c = clientToCanvas(e.clientX, e.clientY);
    const wpt = screenToWorld(c.x, c.y);
    g.node.fx = wpt.x;
    g.node.fy = wpt.y;
    g.node.x = wpt.x;
    g.node.y = wpt.y;
    S.dirty = true;
    startLoop();
  } else {
    S.view.x = g.view0.x + dx;
    S.view.y = g.view0.y + dy;
    S.dirty = true;
    startLoop();
  }
}

function onPointerUp(e) {
  if (!S) return;
  const p = S.pointers.get(e.pointerId);
  S.pointers.delete(e.pointerId);
  const g = S.gesture;
  if (!p || !g) return;
  if (g.kind === 'pinch') {
    if (S.pointers.size === 1) {
      const [rest] = [...S.pointers.values()];
      S.gesture = { kind: 'pan', node: null, moved: true, startX: rest.x, startY: rest.y, view0: { ...S.view }, pointerType: e.pointerType };
    } else if (S.pointers.size === 0) {
      S.gesture = null;
    }
    return;
  }
  S.els.canvas.classList.remove('panning');
  if (g.kind === 'node' && g.moved) endDrag(g.node);
  if (!g.moved && e.type !== 'pointercancel') onTap(g.node, e);
  S.gesture = null;
  if (S.pointers.size) S.pointers.clear();
}

function onPointerLeave(e) {
  if (!S) return;
  if (e.pointerType === 'mouse' && S.hover && !S.pointers.size) {
    S.hover = null;
    S.els.canvas.classList.remove('overnode');
    S.dirty = true;
    startLoop();
  }
}

function onTap(node, e) {
  const now = e.timeStamp || performance.now();
  const last = S.lastTap;
  S.lastTap = { t: now, x: e.clientX, y: e.clientY, node };
  if (!node && last && !last.node && now - last.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30) {
    S.lastTap = null;
    fitView(true);
    return;
  }
  if (node) {
    haptic('light');
    select(node, true);
  } else if (S.sel) {
    deselect(true);
  }
}

function updateHover(e) {
  const node = nodeAt(e.clientX, e.clientY);
  if (node === S.hover) return;
  S.hover = node;
  S.els.canvas.classList.toggle('overnode', Boolean(node));
  S.dirty = true;
  startLoop();
}

function beginDrag(node) {
  node.fx = node.x;
  node.fy = node.y;
  holdReload(HOLD_DRAG);
  S.alphaTarget = 0.3;
  S.alpha = Math.max(S.alpha, 0.3);
  startLoop();
}

function endDrag(node) {
  node.fx = null;
  node.fy = null;
  S.alphaTarget = 0;
  releaseReload(HOLD_DRAG);
  startLoop();
}

function onWheel(e) {
  if (!S || !S.loaded) return;
  e.preventDefault();
  const c = clientToCanvas(e.clientX, e.clientY);
  if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0022));
    zoomAt(c.x, c.y, factor);
  } else {
    S.view.x -= e.deltaX;
    S.view.y -= e.deltaY;
    S.autoFit = false;
    S.dirty = true;
    startLoop();
  }
}

// ---------------------------------------------------------------- selection

function select(node, updateHash) {
  S.sel = node;
  S.selAdj = new Set(node.adj);
  renderCard(node);
  S.dirty = true;
  startLoop();
  if (updateHash) nav.replace(`#/graph/${encodeURIComponent(node.id)}`);
}

function deselect(updateHash) {
  if (!S.sel) return;
  S.sel = null;
  S.selAdj = null;
  S.els.card.hidden = true;
  S.dirty = true;
  startLoop();
  if (updateHash) nav.replace('#/graph');
}

// Deep link: select + centre; a type that is filtered off is turned back on.
function openNodeById(id) {
  const node = S.byId.get(id);
  if (!node) {
    toast('That node is not in the graph');
    nav.replace('#/graph');
    return;
  }
  if (!node.vis) setFilters({ ...S.filters, [node.type]: true });
  select(node, false);
  centreOn(node, true);
}

function openSelected() {
  const node = S.sel;
  if (!node || !node.route) return;
  haptic('light');
  S.ctx.nav.go(node.route);
}

function renderCard(node) {
  const { card, cardDot, cardThumb, cardTitle, cardMeta, openBtn, centreBtn } = S.els;
  cardDot.style.background = node.color;
  cardTitle.textContent = node.label;
  cardMeta.textContent = describe(node);
  const thumb = node.type === 'post' && node.meta && typeof node.meta.thumb === 'string' ? node.meta.thumb : null;
  if (thumb && /^[\w.-]+$/.test(thumb)) {
    cardThumb.src = `/media/jakestagram/${encodeURIComponent(thumb)}`;
    cardThumb.hidden = false;
    cardDot.hidden = true;
  } else {
    cardThumb.removeAttribute('src');
    cardThumb.hidden = true;
    cardDot.hidden = false;
  }
  const appLabel = node.app && S.appLabels ? S.appLabels[node.app] : null;
  openBtn.hidden = !node.route;
  openBtn.textContent = appLabel ? `Open in ${appLabel}` : 'Open';
  centreBtn.textContent = 'Centre';
  card.hidden = false;
}

function describe(node) {
  const m = node.meta || {};
  const parts = [TYPE_NAME[node.type] || node.type];
  const links = `${node.deg} ${node.deg === 1 ? 'link' : 'links'}`;
  switch (node.type) {
    case 'task':
      parts.push(m.done ? 'done' : 'open');
      if (node.date) parts.push(dateLabel(node.date));
      break;
    case 'event':
      if (node.date) parts.push(dateLabel(node.date));
      parts.push(m.all_day ? 'all day' : (m.start_time ? timeLabel(m.start_time) : null));
      break;
    case 'post':
      parts[0] = m.kind === 'video' ? 'Video post' : 'Photo';
      if (node.date) parts.push(dateLabel(node.date));
      break;
    case 'video':
      if (m.channel) parts.push(String(m.channel));
      if (m.duration) parts.push(fmt.duration(m.duration));
      break;
    case 'chat':
      if (m.model) parts.push(String(m.model));
      if (node.date) parts.push(dateLabel(node.date));
      break;
    case 'habit':
      parts.push(`${m.checks || 0} check-ins in 60 days`);
      if (m.archived) parts.push('archived');
      break;
    case 'day':
      if (node.date) parts.push(dateLabel(node.date, true));
      break;
    case 'tag':
      break;
    default:
      if (node.date) parts.push(dateLabel(node.date));
      if (m.pinned) parts.push('pinned');
  }
  parts.push(links);
  return parts.filter(Boolean).join(' · ');
}

function dateLabel(day, long = false) {
  const [y, mo, d] = String(day).split('-').map(Number);
  if (!y || !mo || !d) return String(day);
  const date = new Date(y, mo - 1, d, 12);
  return long ? fmt.date(date, { weekday: 'long', month: 'long', year: true }) : fmt.date(date);
}

function timeLabel(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  if (!m) return String(hhmm || '');
  const d = new Date(2000, 0, 1, Number(m[1]), Number(m[2]));
  return fmt.time(d);
}

// ---------------------------------------------------------------- synthetic data (tests)

// window.__jdGraph.loadSynthetic(800): a plausible graph of n nodes for frame-time checks.
function loadSynthetic(n = 800) {
  if (!S) return;
  const types = ['note', 'task', 'event', 'post', 'video', 'chat'];
  const apps = { note: 'notes', task: 'tasks', event: 'calendar', post: 'jakestagram', video: 'jaketube', chat: 'jakegpt' };
  const days = Math.max(4, Math.round(n / 12));
  const tags = Math.max(3, Math.round(n / 40));
  const nodes = [];
  const edges = [];
  const two = (x) => String(x).padStart(2, '0');
  for (let d = 0; d < days; d++) {
    const date = new Date(2026, 9, 1 + d, 12);
    const key = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
    nodes.push({ id: `day:${key}`, type: 'day', label: fmt.date(date), app: 'calendar', route: `#/calendar/${key.slice(0, 7)}`, date: key, meta: {} });
  }
  for (let t = 0; t < tags; t++) nodes.push({ id: `tag:t${t}`, type: 'tag', label: `#tag${t}`, app: null, route: null, date: null, meta: {} });
  const items = n - days - tags;
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < items; i++) {
    const type = types[Math.floor(rnd() * types.length)];
    const dayIdx = Math.min(days - 1, Math.floor(Math.pow(rnd(), 1.5) * days));
    const dayId = nodes[dayIdx].id;
    const id = `${type}:${i}`;
    nodes.push({ id, type, label: `${TYPE_NAME[type]} ${i}`, app: apps[type], route: `#/${apps[type]}`, date: nodes[dayIdx].date, meta: {} });
    edges.push({ source: id, target: dayId, kind: 'day' });
    if (rnd() < 0.35) edges.push({ source: id, target: `tag:t${Math.floor(rnd() * tags)}`, kind: 'tag' });
    if (rnd() < 0.08) edges.push({ source: id, target: `tag:t${Math.floor(rnd() * tags)}`, kind: 'tag' });
    if (type === 'note' && i > 0 && rnd() < 0.2) edges.push({ source: id, target: `note:${Math.floor(rnd() * i)}`, kind: 'link' });
  }
  S.byId = new Map();
  S.sel = null;
  S.selAdj = null;
  S.els.card.hidden = true;
  const counts = {};
  for (const nd of nodes) counts[nd.type] = (counts[nd.type] || 0) + 1;
  setData({ nodes, edges, generated_at: new Date().toISOString(), truncated: false, counts });
}
