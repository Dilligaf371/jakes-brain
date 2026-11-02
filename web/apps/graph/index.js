// Graph app: an Obsidian-like graph of all of Jake's data on a full-bleed <canvas>.
// Data: GET /api/graph (nodes + edges built read-only from the other apps' tables).
// Own force simulation (no library): grid-bucketed repulsion (exact inside the 3x3 cell
// neighbourhood, cell centroids beyond it), spring edges, centre gravity, cooling (~300 ticks)
// and re-heat on drag. Interactions: drag empty space = pan, pinch / wheel = zoom (0.2–4),
// drag a node, tap/click a node = select (neighbours highlighted, bottom card with Open),
// hover (mouse) shows the label, double-tap / double-click empty space = fit.
// Nav bar right: filter + search sheet (type toggles persisted in kit.store 'graph.filters').
// Sub-route #/graph/<nodeId> selects and centres that node.
// 3D (the 3D button): the same simulation gains a z axis and the canvas draws a perspective
// projection with depth fog. Drag empty space = turn the graph (a flick keeps it turning),
// shift-drag = pan, Spin = turn on its own, pausing while the mouse is on a node.
// Full fills the monitor the window is on (hidden where the browser has no fullscreen API,
// which is the iPhone, where the app already fills the screen).
import * as kit from '../../kit.js';

const { api, el, fmt, toast, haptic, navbar, navButton, icon, store, nav, holdReload, releaseReload, debounce, emptyState } = kit;

const FILTERS_KEY = 'graph.filters';
const HOLD_SEARCH = 'graph:search';
const HOLD_DRAG = 'graph:drag';
const HOLD_FULL = 'graph:fullscreen';
const MODE_KEY = 'graph.mode';

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
  { type: 'reminder', label: 'Reminders', app: 'reminders' },
  { type: 'reel', label: 'Reels', app: 'reels' },
  { type: 'idea', label: 'Reel ideas', app: 'reels' },
  { type: 'hook', label: 'Hooks', app: 'reels' },
  { type: 'day', label: 'Days', app: null, color: '#8e8e93' },
  { type: 'tag', label: 'Tags', app: null, color: '#64d2ff' },
];
const TYPE_NAME = { note: 'Note', task: 'Task', event: 'Event', post: 'Post', video: 'Video', chat: 'Chat', habit: 'Habit', deal: 'Deal', person: 'Person', link: 'Saved link', focus: 'Focus', reminder: 'Reminder', reel: 'Reel', idea: 'Reel idea', hook: 'Hook', day: 'Day', tag: 'Tag' };
// Used only when /apps.json cannot be read (the tile colours from SPEC.md).
const FALLBACK = { notes: '#ffcc00', tasks: '#5e5ce6', calendar: '#ffffff', jakestagram: '#e1306c', jaketube: '#e62117', jakegpt: '#10a37f', habits: '#ff9f0a', graph: '#bf5af2' };
const FALLBACK_LABELS = { notes: 'Notes', tasks: 'Tasks', calendar: 'Calendar', jakestagram: 'Jakestagram', jaketube: 'JakeTube', jakegpt: 'JakeGPT', habits: 'Habits' };

// Simulation (d3-force-like units: positions in world px, velocities per tick).
const ALPHA_MIN = 0.001;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300); // ~300 ticks from 1 to ALPHA_MIN
const VELOCITY_KEEP = 0.55;                            // velocity decay 0.45
const REPEL = 190;                                      // many-body strength (times mass)
const REPEL_CELL = 110;                                // exact pairwise inside the 3x3 neighbourhood of this cell size
const MAX_GRID = 40;                                   // cells per axis cap (the cell grows instead)
const LINK_DIST = 64;                                  // one rest length, like Obsidian
const LABEL_COLLIDE_MAX = 400;                         // beyond this many on-screen labels, skip the overlap pass
const GRAVITY = 0.02;
const GRAVITY_3D = 0.32;                                // measured: at 0.02 the islands drift so far that the core ends up tiny
const TUNE_KEY = 'graph.tune';
const TUNE_DEFAULT = { textFade: 1, nodeSize: 1, linkWidth: 1, center: 1, repel: 1, link: 1, distance: 1, colors: false, orphans: true };
const ACCENT_MIX = 0.22;                               // per-frame easing of the hover highlight
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const FIT_MAX_ZOOM = 1.25;
const TICK_BUDGET_MS = 7;                              // simulation time per frame
const MAX_TICKS_PER_FRAME = 3;
const TAP_SLOP = 6;
const DOUBLE_TAP_MS = 320;
const HIT_PAD = 9;                                     // screen px around a node that still hits it
const SPIN_RATE = 0.25;                                 // radians per second
const ORBIT_SPEED = 0.006;                             // radians per dragged pixel
const INERTIA_KEEP = 0.94;                             // per 60 Hz frame, after a flick
const CAMERA = 2.5;                                    // camera distance, in graph radii
const FOG = 0.72;                                      // how much the back of the graph fades
const LABEL_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif';

let S = null;       // the whole app state while mounted
let listeners = [];

export default {
  mount(root, ctx) {
    root.classList.add('full-bleed');
    const mode = loadMode();
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
      tune: loadTune(),
      fade: 0,
      fadeNode: null,
      fadeBusy: false,
      query: '',
      matches: 0,
      sel: null,
      selAdj: null,
      hover: null,
      view: { x: 0, y: 0, k: 1 },
      d3: mode.d3,
      spin: mode.spin,
      depth: mode.d3 ? 1 : 0,
      rot: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      spinV: { yaw: 0, pitch: 0 },
      radius: 1,
      cam: 1,
      order: [],
      lastFrame: 0,
      labelBusy: false,
      fullscreen: false,
      fullExitAt: 0,
      refitUntil: 0,
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
    listen(document, 'fullscreenchange', onFullscreenChange);
    listen(document, 'keydown', onKeyDown);
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
        if (!n) return null;
        return is3d() ? { x: n.sx, y: n.sy } : worldToScreen(n.x, n.y);
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
    releaseReload(HOLD_FULL);
    if (S && document.fullscreenElement === S.root) document.exitFullscreen().catch(() => {});
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
  const modeBtn = el('button', { class: 'gfit', type: 'button', text: '3D', 'aria-label': 'Show in 3D', 'aria-pressed': 'false', 'on:click': () => set3d(!S.d3) });
  const spinBtn = el('button', { class: 'gfit', type: 'button', text: 'Spin', 'aria-label': 'Spin the graph', 'aria-pressed': 'false', 'on:click': toggleSpin });
  const fullBtn = el('button', { class: 'gfit', type: 'button', text: 'Full', 'aria-label': 'Fill the screen', 'on:click': toggleFullscreen });
  fullBtn.hidden = !document.fullscreenEnabled;
  // The nav bar is gone in fullscreen, so the filter button moves down here.
  const fullFilterBtn = el('button', { class: 'gfit gfsonly', type: 'button', text: 'Filter', 'on:click': openSheet });
  const btns = el('div', { class: 'gbtns' }, fullFilterBtn, modeBtn, spinBtn, fitBtn, fullBtn);
  const info = el('div', { class: 'ginfo' }, el('div', { class: 'ginfo-left' }, stats, searchPill), btns);

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

  S.els = { bar, canvas, stage, info, stats, searchPill, fitBtn, modeBtn, spinBtn, fullBtn, empty, noMatch, card, cardDot, cardThumb, cardTitle, cardMeta, openBtn, centreBtn, ...sheet };
  S.g = canvas.getContext('2d', { alpha: false });
  syncMode();

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
    tuneGroup('Display', [
      toggle('colors', 'Colour by app'), toggle('orphans', 'Orphans'),
      slider('textFade', 'Text fade', 0.4, 2, 0.05), slider('nodeSize', 'Node size', 0.5, 2, 0.05), slider('linkWidth', 'Link thickness', 0.4, 2.5, 0.05),
    ]),
    tuneGroup('Forces', [
      slider('center', 'Centre force', 0, 3, 0.05), slider('repel', 'Repel force', 0.2, 3, 0.05),
      slider('link', 'Link force', 0.2, 2, 0.05), slider('distance', 'Link distance', 0.4, 3, 0.05),
    ]),
    el('div', { class: 'gsheet-group' }, el('button', { class: 'gsheet-done gsheet-reset', type: 'button', text: 'Reset display and forces', 'on:click': resetTune })),
    el('div', { class: 'gsheet-group' }, done));
  const host = el('div', { class: 'gsheet', hidden: true }, backdrop, panel);
  return { host, sheetPanel: panel, sheetBackdrop: backdrop, searchInput: input, searchCount: count, typeRows: rows };
}

function tuneGroup(title, rows) {
  return el('div', { class: 'gsheet-group' }, el('div', { class: 'gsheet-head' }, el('span', { class: 'gsheet-title', text: title })), rows);
}

function slider(key, label, min, max, step) {
  const input = el('input', { class: 'grange', type: 'range', min, max, step, 'aria-label': label });
  input.value = S.tune[key];
  input.dataset.tune = key;
  input.addEventListener('input', () => setTune(key, Number(input.value)));
  return el('label', { class: 'grange-row' }, el('span', { text: label }), input);
}

function toggle(key, label) {
  const sw = el('button', { class: 'gswitch', type: 'button', role: 'switch', 'aria-checked': String(Boolean(S.tune[key])), 'aria-label': label });
  sw.dataset.tune = key;
  sw.addEventListener('click', () => {
    haptic('light');
    setTune(key, !S.tune[key]);
    sw.setAttribute('aria-checked', String(Boolean(S.tune[key])));
  });
  return el('div', { class: 'grow' }, el('span', { class: 'glabel', text: label }), sw);
}

function loadTune() {
  const saved = kit.store.get(TUNE_KEY, null);
  const out = { ...TUNE_DEFAULT };
  if (saved && typeof saved === 'object') {
    for (const key of Object.keys(out)) if (typeof saved[key] === typeof out[key]) out[key] = saved[key];
  }
  return out;
}

function setTune(key, value) {
  S.tune[key] = value;
  kit.store.set(TUNE_KEY, S.tune);
  applyTune();
}

function resetTune() {
  S.tune = { ...TUNE_DEFAULT };
  kit.store.del(TUNE_KEY);
  for (const input of S.root.querySelectorAll('[data-tune]')) {
    if (input.type === 'range') input.value = S.tune[input.dataset.tune];
    else input.setAttribute('aria-checked', String(Boolean(S.tune[input.dataset.tune])));
  }
  applyTune();
}

function sizeNodes() {
  for (const n of S.nodes) {
    n.r = Math.min(24, 2.8 + 1.7 * Math.sqrt(n.deg)) * S.tune.nodeSize;
    n.m = 0.55 + n.r / 7;
  }
}

function applyTune() {
  sizeNodes();
  for (const e of S.edges) e.dist = linkDistance(e);
  recolor();
  applyFilters(0.5);
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
  S.els.modeBtn.hidden = n < 2;
  syncMode();
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
      z: old ? old.z : 0,
      vx: 0,
      vy: 0,
      vz: 0,
      fx: null,
      fy: null,
      fz: null,
      sx: 0,
      sy: 0,
      ss: 1,
      rx: 0,
      ry: 0,
      rz: 0,
      la: 0,
      want: 0,
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
    const kind = raw.kind === 'tag' ? 'tag' : raw.kind === 'day' ? 'day' : 'link';
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
  // Initial positions: a phyllotaxis spiral for the whole set the first time, and new nodes
  // next to an already-placed neighbour afterwards.
  const firstTime = prev.size === 0;
  const spiral = (i) => {
    const radius = 5 * Math.sqrt(0.5 + i);
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
        n.z = buddy.z + (Math.random() - 0.5) * 20;
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
  sizeNodes();
  if (S.d3) seedDepth();
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
  for (const n of S.nodes) n.vis = f[n.type] !== false && (S.tune.orphans || n.deg > 0);
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
  if (!S.tune.colors) return type === 'tag' ? S.pal.tag : S.pal.node;
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

// Obsidian's default graph colours: grey notes, green tags, purple on hover.
function palette(dark) {
  return dark
    ? { bg: '#1e1e1e', node: '#b3b3b3', tag: '#5fa777', accent: '#a78bfa', edge: 'rgba(255,255,255,0.15)', label: 'rgba(220,221,222,0.86)', labelHi: '#ffffff', halo: '#1e1e1e', ring: '#ffffff', match: '#ffd60a', nodeDim: 0.14 }
    : { bg: '#ffffff', node: '#8a8a8a', tag: '#3f9c61', accent: '#7c5cf0', edge: 'rgba(0,0,0,0.14)', label: 'rgba(46,46,46,0.86)', labelHi: '#000000', halo: '#ffffff', ring: '#1c1c1e', match: '#ff9f0a', nodeDim: 0.16 };
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
  const dt = Math.min(0.05, (now - S.lastFrame) / 1000 || 0);
  S.lastFrame = now;
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
  const focus = focusNode();
  const target = focus ? 1 : 0;
  S.fadeBusy = S.fade !== target;
  if (S.fadeBusy) {
    S.fade += (target - S.fade) * (S.reduced ? 1 : ACCENT_MIX);
    if (Math.abs(target - S.fade) < 0.01) S.fade = target;
    S.dirty = true;
  }
  if (focus) S.fadeNode = focus;
  stepDepth();
  stepSpin(dt);
  if (S.dirty || S.labelBusy) {
    draw();
    S.dirty = false;
  }
  const t2 = performance.now();
  S.stats.drawMs = t2 - t1;
  S.stats.frameMs = t2 - t0;
  S.stats.frames += 1;
  const turning = S.d3 && (S.spin || S.spinV.yaw || S.spinV.pitch);
  if (S.alpha > ALPHA_MIN || S.alphaTarget > 0 || S.tween || S.fadeBusy || S.labelBusy || turning || S.depth !== (S.d3 ? 1 : 0)) S.raf = requestAnimationFrame(frame);
}

function focusNode() {
  if (S.sel && S.sel.vis) return S.sel;
  return S.hover && S.hover.vis ? S.hover : null;
}

function tick() {
  const alpha = S.alpha;
  const vis = S.visNodes;
  const d3 = S.d3;
  if (d3) repel3(vis, alpha);
  else repel(vis, alpha);
  // Springs (d3 link force: strength 1/min(deg), bias toward the lighter end).
  for (const e of S.visEdges) {
    const a = e.a;
    const b = e.b;
    let dx = b.x + b.vx - a.x - a.vx;
    let dy = b.y + b.vy - a.y - a.vy;
    let dz = d3 ? b.z + b.vz - a.z - a.vz : 0;
    if (dx === 0 && dy === 0 && dz === 0) {
      dx = (Math.random() - 0.5) * 1e-3;
      dy = (Math.random() - 0.5) * 1e-3;
    }
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const strength = S.tune.link / Math.min(a.deg || 1, b.deg || 1);
    const f = ((l - e.dist) / l) * alpha * strength;
    dx *= f;
    dy *= f;
    dz *= f;
    const bias = a.deg / (a.deg + b.deg || 1);
    b.vx -= dx * bias;
    b.vy -= dy * bias;
    b.vz -= dz * bias;
    a.vx += dx * (1 - bias);
    a.vy += dy * (1 - bias);
    a.vz += dz * (1 - bias);
  }
  // Centre gravity + integration.
  for (const n of vis) {
    if (n.fx != null) {
      n.x = n.fx;
      n.y = n.fy;
      if (d3) n.z = n.fz;
      n.vx = 0;
      n.vy = 0;
      n.vz = 0;
      continue;
    }
    // Unlinked nodes get a stronger pull so they orbit close instead of a distant ring.
    const pull = (d3 ? GRAVITY_3D : GRAVITY) * S.tune.center * alpha * (n.deg ? 1 : 3);
    n.vx -= n.x * pull;
    n.vy -= n.y * pull;
    n.vx *= VELOCITY_KEEP;
    n.vy *= VELOCITY_KEEP;
    n.x += n.vx;
    n.y += n.vy;
    if (d3) {
      n.vz -= n.z * pull;
      n.vz *= VELOCITY_KEEP;
      n.z += n.vz;
    }
  }
  // Keep the middle of the graph on the origin, the point it turns around. Not during a
  // drag: the held node stays put, so shifting everything else would slide the graph.
  if (d3 && !S.alphaTarget && vis.length) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const n of vis) {
      cx += n.x;
      cy += n.y;
      cz += n.z;
    }
    cx /= vis.length;
    cy /= vis.length;
    cz /= vis.length;
    for (const n of vis) {
      n.x -= cx;
      n.y -= cy;
      n.z -= cz;
    }
  }
  S.alpha += (S.alphaTarget - S.alpha) * ALPHA_DECAY;
}

function linkDistance() {
  return LINK_DIST * S.tune.distance;
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
  const K = REPEL * S.tune.repel * alpha;
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

// Repulsion in 3D: every pair, exactly. The graph has at most 2000 nodes and the simulation
// sleeps once it cools, so this stays simpler than a 3D version of the grid above.
function repel3(vis, alpha) {
  const K = REPEL * S.tune.repel * alpha;
  const n = vis.length;
  for (let i = 0; i < n; i++) {
    const a = vis[i];
    for (let j = i + 1; j < n; j++) {
      const b = vis[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let dz = a.z - b.z;
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1) {
        dx = (Math.random() - 0.5) || 0.5;
        dy = (Math.random() - 0.5) || 0.5;
        dz = (Math.random() - 0.5) || 0.5;
        d2 = dx * dx + dy * dy + dz * dz;
      }
      const f = K / d2;
      a.vx += dx * f * b.m;
      a.vy += dy * f * b.m;
      a.vz += dz * f * b.m;
      b.vx -= dx * f * a.m;
      b.vy -= dy * f * a.m;
      b.vz -= dz * f * a.m;
    }
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
  const refit = S.autoFit || performance.now() < S.refitUntil;
  S.w = w;
  S.h = h;
  S.dpr = dpr;
  S.els.canvas.width = Math.round(w * dpr);
  S.els.canvas.height = Math.round(h * dpr);
  S.els.canvas.style.width = `${w}px`;
  S.els.canvas.style.height = `${h}px`;
  if (refit && S.visNodes.length) fitView(false);
  S.dirty = true;
  startLoop();
}

function navHeight() {
  if (S.fullscreen) return 0;
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
  if (is3d()) {
    // Fit the whole sphere, so nothing leaves the screen while it turns.
    projectAll();
    const k = clampZoom(Math.min(availW, availH) / (2.2 * S.radius));
    return { k: Math.min(FIT_MAX_ZOOM, k), x: S.w / 2, y: top + availH / 2 };
  }
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
  let nx = node.x;
  let ny = node.y;
  if (is3d()) {
    projectAll();
    nx = node.rx * node.ss;
    ny = node.ry * node.ss;
  }
  const target = { k, x: S.w / 2 - nx * k, y: top + (S.h - top - bottom) / 2 - ny * k };
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

// ---------------------------------------------------------------- 3D and fullscreen

function loadMode() {
  const saved = store.get(MODE_KEY, null);
  return { d3: Boolean(saved && saved.d3), spin: Boolean(saved && saved.spin) };
}

function saveMode() {
  store.set(MODE_KEY, { d3: S.d3, spin: S.spin });
}

function syncMode() {
  const { modeBtn, spinBtn, canvas } = S.els;
  modeBtn.setAttribute('aria-pressed', String(S.d3));
  spinBtn.setAttribute('aria-pressed', String(S.spin));
  spinBtn.hidden = !S.d3 || S.visNodes.length < 2;
  canvas.classList.toggle('g3d', S.d3);
}

// True while the 3D drawing path is in charge, including the flatten back to 2D.
function is3d() {
  return S.d3 || S.depth > 0;
}

function seedDepth() {
  let r2 = 1;
  for (const n of S.nodes) r2 = Math.max(r2, n.x * n.x + n.y * n.y);
  const spread = Math.sqrt(r2);
  for (const n of S.nodes) if (!n.z) n.z = (Math.random() - 0.5) * spread;
}

function set3d(on) {
  if (!S || S.d3 === on) return;
  haptic('light');
  const view = S.view;
  if (on) {
    // Move the middle of the graph to the origin; the view shifts to match, so nothing jumps.
    const vis = S.visNodes;
    let cx = 0;
    let cy = 0;
    for (const n of vis) {
      cx += n.x;
      cy += n.y;
    }
    cx /= vis.length || 1;
    cy /= vis.length || 1;
    for (const n of S.nodes) {
      n.x -= cx;
      n.y -= cy;
    }
    view.x += cx * view.k;
    view.y += cy * view.k;
    seedDepth();
    // A small push, because a graph seen head-on looks the same as the flat one.
    S.spinV = { yaw: S.reduced ? 0 : 0.02, pitch: S.reduced ? 0 : 0.008 };
  } else {
    // Turn the coordinates themselves by the current rotation, so the graph flattens from
    // exactly the angle it was left at.
    const m = S.rot;
    for (const n of S.nodes) {
      const x = n.x;
      const y = n.y;
      const z = n.z * S.depth;
      n.x = m[0] * x + m[1] * y + m[2] * z;
      n.y = m[3] * x + m[4] * y + m[5] * z;
      n.z = m[6] * x + m[7] * y + m[8] * z;
      n.vx = 0;
      n.vy = 0;
      n.vz = 0;
    }
    S.rot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    S.depth = 1;
    S.spinV = { yaw: 0, pitch: 0 };
  }
  S.d3 = on;
  S.tween = null;
  S.autoFit = true;
  saveMode();
  syncMode();
  startSim(on ? 1 : 0.6);
  S.dirty = true;
  startLoop();
}

function toggleSpin() {
  haptic('light');
  S.spin = !S.spin;
  saveMode();
  syncMode();
  startLoop();
}

function stepDepth() {
  const target = S.d3 ? 1 : 0;
  if (S.depth === target) return;
  S.depth += (target - S.depth) * (S.reduced ? 1 : 0.12);
  if (Math.abs(target - S.depth) < 0.004) S.depth = target;
  S.dirty = true;
}

function stepSpin(dt) {
  if (!S.d3) return;
  // A finger or mouse on the graph, or the mouse resting on a node so it can be read.
  if (S.pointers.size || (S.hover && S.hover.vis)) return;
  const v = S.spinV;
  const frames = dt * 60;
  const yaw = (S.spin ? SPIN_RATE * dt : 0) + v.yaw * frames;
  const pitch = v.pitch * frames;
  const keep = Math.pow(INERTIA_KEEP, frames);
  v.yaw = Math.abs(v.yaw * keep) < 1e-4 ? 0 : v.yaw * keep;
  v.pitch = Math.abs(v.pitch * keep) < 1e-4 ? 0 : v.pitch * keep;
  if (yaw || pitch) {
    rotate(yaw, pitch);
    S.dirty = true;
  }
}

// Turns the graph around the screen's vertical (yaw) and horizontal (pitch) axes.
function rotate(yaw, pitch) {
  const m = S.rot;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  for (let j = 0; j < 3; j++) {
    const x = m[j];
    const y = m[3 + j];
    const z = m[6 + j];
    const z1 = cy * z - sy * x;
    m[j] = cy * x + sy * z;
    m[3 + j] = cp * y - sp * z1;
    m[6 + j] = sp * y + cp * z1;
  }
  // Rounding adds up over hours of spinning and would shear the picture; square it up again.
  const a = Math.hypot(m[0], m[1], m[2]);
  m[0] /= a;
  m[1] /= a;
  m[2] /= a;
  const d = m[0] * m[3] + m[1] * m[4] + m[2] * m[5];
  m[3] -= d * m[0];
  m[4] -= d * m[1];
  m[5] -= d * m[2];
  const b = Math.hypot(m[3], m[4], m[5]);
  m[3] /= b;
  m[4] /= b;
  m[5] /= b;
  m[6] = m[1] * m[5] - m[2] * m[4];
  m[7] = m[2] * m[3] - m[0] * m[5];
  m[8] = m[0] * m[4] - m[1] * m[3];
}

// Screen position of every visible node. With depth 0 and no rotation this is the 2D view.
function projectAll() {
  const m = S.rot;
  const depth = S.depth;
  const { x: vx, y: vy, k } = S.view;
  const vis = S.visNodes;
  let r2 = 1;
  for (const n of vis) {
    const z = n.z * depth;
    const d = n.x * n.x + n.y * n.y + z * z;
    if (d > r2) r2 = d;
  }
  S.radius = Math.sqrt(r2);
  const cam = S.cam = S.radius * CAMERA;
  for (const n of vis) {
    const z = n.z * depth;
    const rz = m[6] * n.x + m[7] * n.y + m[8] * z;
    const s = cam / (cam + rz);
    n.rx = m[0] * n.x + m[1] * n.y + m[2] * z;
    n.ry = m[3] * n.x + m[4] * n.y + m[5] * z;
    n.rz = rz;
    n.ss = s;
    n.sx = vx + k * s * n.rx;
    n.sy = vy + k * s * n.ry;
  }
}

// The world point under a screen point, at camera depth rz.
function unproject(sx, sy, rz) {
  const s = S.cam / (S.cam + rz);
  const rx = (sx - S.view.x) / (S.view.k * s);
  const ry = (sy - S.view.y) / (S.view.k * s);
  const m = S.rot;
  return {
    x: m[0] * rx + m[3] * ry + m[6] * rz,
    y: m[1] * rx + m[4] * ry + m[7] * rz,
    z: m[2] * rx + m[5] * ry + m[8] * rz,
  };
}

function toggleFullscreen() {
  haptic('light');
  const change = document.fullscreenElement ? document.exitFullscreen() : S.root.requestFullscreen();
  Promise.resolve(change).catch(() => toast("Full screen isn't available here"));
}

function onFullscreenChange() {
  if (!S) return;
  const on = document.fullscreenElement === S.root;
  if (!on && S.fullscreen) S.fullExitAt = performance.now();
  S.fullscreen = on;
  S.els.fullBtn.textContent = on ? 'Exit' : 'Full';
  S.els.fullBtn.setAttribute('aria-label', on ? 'Leave full screen' : 'Fill the screen');
  // A new build must not reload the page and drop the graph out of full screen.
  if (on) holdReload(HOLD_FULL);
  else releaseReload(HOLD_FULL);
  // The window keeps changing size for a moment (macOS animates this), so keep refitting.
  S.refitUntil = performance.now() + 1500;
  resize();
  fitView(false);
  startLoop();
}

// Escape only leaves full screen here. The launcher would otherwise also go back a screen,
// and the browser can deliver the key just after it has already left full screen.
function onKeyDown(e) {
  if (e.key !== 'Escape') return;
  if (document.fullscreenElement === S.root) {
    e.preventDefault();
    document.exitFullscreen().catch(() => {});
  } else if (performance.now() - S.fullExitAt < 400) {
    e.preventDefault();
  }
}

// ---------------------------------------------------------------- drawing

function draw() {
  if (is3d()) {
    draw3d();
    return;
  }
  S.labelBusy = false;
  const g = S.g;
  const { w, h, dpr, pal, view } = S;
  const k = view.k;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = pal.bg;
  g.fillRect(0, 0, w * dpr, h * dpr);
  if (!S.visNodes.length) return;
  g.setTransform(dpr * k, 0, 0, dpr * k, dpr * view.x, dpr * view.y);

  const sel = S.sel;
  const hover = S.hover;
  const fnode = S.fade > 0 ? S.fadeNode : null;
  if (fnode && !fnode.adjSet) fnode.adjSet = new Set(fnode.adj);
  const adj = fnode ? fnode.adjSet : null;
  const searching = Boolean(S.query);
  const dimming = Boolean(fnode) || searching;
  const dimLevel = fnode ? S.fade : 1;
  const isLit = (n) => (fnode ? n === fnode || adj.has(n.idx) : n.match);
  // Culling bounds in world units.
  const wx0 = -view.x / k - 40;
  const wy0 = -view.y / k - 40;
  const wx1 = (w - view.x) / k + 40;
  const wy1 = (h - view.y) / k + 40;
  const onScreen = (n) => n.x >= wx0 && n.x <= wx1 && n.y >= wy0 && n.y <= wy1;

  // Edges: one path for the plain ones, one for the highlighted ones.
  const linkW = S.tune.linkWidth;
  g.lineWidth = Math.max(0.5, 0.9 / k) * linkW;
  g.lineCap = 'round';
  g.strokeStyle = pal.edge;
  g.globalAlpha = dimming ? 1 - 0.8 * dimLevel : 1;
  g.beginPath();
  let lit = null;
  for (const e of S.visEdges) {
    const a = e.a;
    const b = e.b;
    if (!onScreen(a) && !onScreen(b)) continue;
    if (dimming && (fnode ? (a === fnode || b === fnode) : (a.match && b.match))) {
      if (!lit) lit = [];
      lit.push(e);
      continue;
    }
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
  }
  g.stroke();
  g.globalAlpha = 1;
  if (lit) {
    g.strokeStyle = pal.accent;
    g.globalAlpha = Math.max(0.15, dimLevel);
    g.lineWidth = Math.max(0.8, 1.4 / k) * linkW;
    g.beginPath();
    for (const e of lit) {
      g.moveTo(e.a.x, e.a.y);
      g.lineTo(e.b.x, e.b.y);
    }
    g.stroke();
    g.globalAlpha = 1;
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
      if (n === fnode) continue;
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
      g.globalAlpha = 1 - (1 - pal.nodeDim) * dimLevel;
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

  if (fnode && fnode.vis) {
    g.fillStyle = pal.accent;
    g.beginPath();
    g.arc(fnode.x, fnode.y, Math.max(minR, fnode.r), 0, TAU);
    g.fill();
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

  drawLabels({ sel, hover, fnode, adj, searching, dimming, dimLevel, onScreen });
}

// Screen-space node drawing: fog fades the far side, near nodes paint over far ones.
function draw3d() {
  const g = S.g;
  const { w, h, dpr, pal, view } = S;
  const k = view.k;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = pal.bg;
  g.fillRect(0, 0, w, h);
  S.labelBusy = false;
  if (!S.visNodes.length) return;
  projectAll();

  const sel = S.sel;
  const hover = S.hover;
  const fnode = S.fade > 0 ? S.fadeNode : null;
  if (fnode && !fnode.adjSet) fnode.adjSet = new Set(fnode.adj);
  const adj = fnode ? fnode.adjSet : null;
  const searching = Boolean(S.query);
  const dimming = Boolean(fnode) || searching;
  const dimLevel = fnode ? S.fade : 1;
  const isLit = (n) => (fnode ? n === fnode || adj.has(n.idx) : n.match);
  const onScreen = (n) => n.sx >= -40 && n.sx <= w + 40 && n.sy >= -40 && n.sy <= h + 40;
  const R = S.radius;
  const far = (rz) => Math.min(1, Math.max(0, (rz + R) / (2 * R)));

  // Edges: four depth bands, far first, so a stroke per band gives the fog.
  const linkW = S.tune.linkWidth;
  const bands = [[], [], [], []];
  let lit = null;
  for (const e of S.visEdges) {
    const a = e.a;
    const b = e.b;
    if (!onScreen(a) && !onScreen(b)) continue;
    if (dimming && (fnode ? (a === fnode || b === fnode) : (a.match && b.match))) {
      if (!lit) lit = [];
      lit.push(e);
      continue;
    }
    bands[Math.min(3, Math.floor(far((a.rz + b.rz) / 2) * 4))].push(e);
  }
  g.lineCap = 'round';
  g.lineWidth = Math.max(0.9, 0.5 * k) * linkW;
  g.strokeStyle = pal.edge;
  const edgeDim = dimming ? 1 - 0.8 * dimLevel : 1;
  for (let i = 3; i >= 0; i--) {
    g.globalAlpha = edgeDim * (1 - FOG * S.depth * ((i + 0.5) / 4));
    g.beginPath();
    for (const e of bands[i]) {
      g.moveTo(e.a.sx, e.a.sy);
      g.lineTo(e.b.sx, e.b.sy);
    }
    g.stroke();
  }
  if (lit) {
    g.strokeStyle = pal.accent;
    g.globalAlpha = Math.max(0.15, dimLevel);
    g.lineWidth = Math.max(1.4, 0.8 * k) * linkW;
    g.beginPath();
    for (const e of lit) {
      g.moveTo(e.a.sx, e.a.sy);
      g.lineTo(e.b.sx, e.b.sy);
    }
    g.stroke();
  }

  const order = S.order;
  order.length = 0;
  for (const n of S.visNodes) if (onScreen(n)) order.push(n);
  order.sort((a, b) => b.rz - a.rz);
  const TAU = Math.PI * 2;
  for (const n of order) {
    let alpha = 1 - FOG * S.depth * far(n.rz);
    if (dimming && n !== fnode && !isLit(n)) alpha *= 1 - (1 - pal.nodeDim) * dimLevel;
    g.globalAlpha = alpha;
    g.fillStyle = n === fnode ? pal.accent : n.color;
    g.beginPath();
    g.arc(n.sx, n.sy, Math.max(1.6, n.r * k * n.ss), 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;

  if (searching) {
    g.strokeStyle = pal.match;
    g.lineWidth = 2;
    g.beginPath();
    for (const n of order) {
      if (!n.match) continue;
      const r = Math.max(1.6, n.r * k * n.ss) + 3;
      g.moveTo(n.sx + r, n.sy);
      g.arc(n.sx, n.sy, r, 0, TAU);
    }
    g.stroke();
  }

  drawLabels({ sel, hover, fnode, adj, searching, dimming, dimLevel, onScreen, far });
}

// Labels in screen space (constant size): selected + neighbours + hover + matches always;
// everything at zoom >= 1.6 (day/tag hubs at >= 1.0), fading in over a short band.
// In 3D they ease in and out, because turning the graph changes which ones fit every frame.
function drawLabels({ sel, hover, fnode, adj, searching, dimming, dimLevel, onScreen, far }) {
  const g = S.g;
  const { w, h, dpr, pal, view } = S;
  const k = view.k;
  const flat = !far;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.lineJoin = 'round';
  g.lineWidth = 3;
  g.strokeStyle = pal.halo;
  // Bigger nodes keep their names further out, so the map stays readable when zoomed out.
  const fadeBy = S.tune.textFade;
  const labelAlpha = (n) => {
    const start = (n.deg >= 12 ? 0.16 : n.deg >= 6 ? 0.34 : n.deg >= 3 ? 0.7 : 1.1) * fadeBy;
    return Math.min(1, Math.max(0, (k - start) / 0.1));
  };
  // Collect the candidates (selected first, then hover, neighbours, matches, then the rest)
  // and skip any label whose box overlaps one already placed.
  const wanted = [];
  for (const n of S.visNodes) {
    if (!onScreen(n)) continue;
    let a;
    let pri;
    if (n === sel) { a = 1; pri = 0; } else if (n === hover) { a = 1; pri = 1; } else if ((fnode && adj.has(n.idx)) || (searching && n.match)) { a = 1; pri = 2; } else {
      a = labelAlpha(n);
      if (a <= 0) continue;
      if (dimming) a *= 1 - 0.8 * dimLevel;
      if (!flat) a *= 1 - FOG * S.depth * far(n.rz);
      pri = n.deg >= 6 ? 3 : 4;
    }
    const sx = flat ? n.x * k + view.x : n.sx;
    const sy = flat ? n.y * k + view.y : n.sy;
    const scale = flat ? k : k * n.ss;
    if (sx < -200 || sx > w + 200 || sy < -40 || sy > h + 40) continue;
    wanted.push({ n, a, pri, x: sx, y: sy + Math.max(1.6, n.r * scale) + 4 });
  }
  wanted.sort((u, v) => u.pri - v.pri || v.n.deg - u.n.deg);
  const placed = [];
  const collide = wanted.length <= LABEL_COLLIDE_MAX;
  let font = '';
  const setFont = (n) => {
    const wantFont = `${n.deg >= 12 ? 13 : 11}px ${LABEL_FONT}`;
    if (wantFont !== font) {
      font = wantFont;
      g.font = font;
    }
  };
  const paint = (n, x, y, alpha) => {
    setFont(n);
    g.globalAlpha = alpha;
    g.strokeText(n.text, x, y);
    g.fillStyle = n === sel || n === hover ? pal.labelHi : pal.label;
    g.fillText(n.text, x, y);
  };
  for (const item of wanted) {
    const n = item.n;
    setFont(n);
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
    if (flat) paint(n, item.x, item.y, item.a);
    else n.want = item.a;
  }
  if (!flat) {
    let busy = false;
    const ease = S.reduced ? 1 : 0.16;
    for (const n of S.visNodes) {
      n.la += (n.want - n.la) * ease;
      if (Math.abs(n.want - n.la) < 0.01) n.la = n.want;
      else busy = true;
      n.want = 0;
      if (n.la < 0.02 || !n.text) continue;
      paint(n, n.sx, n.sy + Math.max(1.6, n.r * k * n.ss) + 4, n.la);
    }
    S.labelBusy = busy;
  }
  g.globalAlpha = 1;
}

// ---------------------------------------------------------------- pointer input

function nodeAt(cx, cy) {
  const p = clientToCanvas(cx, cy);
  const k = S.view.k;
  const flat = !is3d();
  let best = null;
  let bestD = Infinity;
  for (const n of S.visNodes) {
    const sx = flat ? n.x * k + S.view.x : n.sx;
    const sy = flat ? n.y * k + S.view.y : n.sy;
    const dx = sx - p.x;
    const dy = sy - p.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const hit = Math.max(n.r * (flat ? k : k * n.ss), 6) + HIT_PAD;
    // In 3D nodes overlap on screen: when two are about as close, the nearer one wins.
    const score = flat ? d : d + (n.rz / S.radius) * 4;
    if (d <= hit && score < bestD) {
      best = n;
      bestD = score;
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
    S.spinV = { yaw: 0, pitch: 0 };
    const empty = S.d3 && !e.shiftKey ? 'orbit' : 'pan';
    S.gesture = { kind: node ? 'node' : empty, node, moved: false, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, lastMove: 0, view0: { ...S.view }, pointerType: e.pointerType };
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
    const wpt = S.d3 ? unproject(c.x, c.y, g.node.rz) : screenToWorld(c.x, c.y);
    g.node.fx = wpt.x;
    g.node.fy = wpt.y;
    g.node.x = wpt.x;
    g.node.y = wpt.y;
    if (S.d3) {
      g.node.fz = wpt.z;
      g.node.z = wpt.z;
    }
    S.dirty = true;
    startLoop();
  } else if (g.kind === 'orbit') {
    const yaw = -(e.clientX - g.lastX) * ORBIT_SPEED;
    const pitch = (e.clientY - g.lastY) * ORBIT_SPEED;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
    g.lastMove = e.timeStamp;
    rotate(yaw, pitch);
    S.spinV = { yaw: yaw * 0.5 + S.spinV.yaw * 0.5, pitch: pitch * 0.5 + S.spinV.pitch * 0.5 };
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
      S.gesture = { kind: S.d3 ? 'orbit' : 'pan', node: null, moved: true, startX: rest.x, startY: rest.y, lastX: rest.x, lastY: rest.y, lastMove: 0, view0: { ...S.view }, pointerType: e.pointerType };
    } else if (S.pointers.size === 0) {
      S.gesture = null;
    }
    return;
  }
  S.els.canvas.classList.remove('panning');
  if (g.kind === 'node' && g.moved) endDrag(g.node);
  if (!g.moved && e.type !== 'pointercancel') onTap(g.node, e);
  // Only a release in motion is a flick; holding still first means stop here.
  if (g.kind === 'orbit' && (S.reduced || e.timeStamp - g.lastMove > 80)) S.spinV = { yaw: 0, pitch: 0 };
  S.gesture = null;
  if (S.pointers.size) S.pointers.clear();
  startLoop();
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
  node.fz = node.z;
  holdReload(HOLD_DRAG);
  S.alphaTarget = 0.3;
  S.alpha = Math.max(S.alpha, 0.3);
  startLoop();
}

function endDrag(node) {
  node.fx = null;
  node.fy = null;
  node.fz = null;
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
  if (!node) return;
  haptic('light');
  if (node.meta.url) {
    el('a', { href: node.meta.url, target: '_blank', rel: 'noopener' }).click();
    return;
  }
  if (node.route) S.ctx.nav.go(node.route);
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
  openBtn.hidden = !node.route && !node.meta.url;
  openBtn.textContent = node.meta.url ? 'Open on Instagram' : appLabel ? `Open in ${appLabel}` : 'Open';
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
    case 'reel':
      if (m.views) parts.push(`${Number(m.views).toLocaleString()} views`);
      if (node.date) parts.push(dateLabel(node.date));
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
