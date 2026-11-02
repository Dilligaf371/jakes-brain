// launcher.js — the home screen (grid + dock + badges), the hash router, app lifecycle
// (lazy import of web/apps/<id>/index.js + its styles.css), the open/close animation, the
// build-change reload with holds, and the foreground/online refresh hooks.
import * as kit from './kit.js';

const { el, toast, haptic, api, nav, normalizeHash } = kit;

const POLL_MS = 30_000;       // /api/version + badge refresh
const ANIM_MS = 220;
const $ = (id) => document.getElementById(id);
const els = { home: $('home'), grid: $('grid'), dock: $('dock'), date: $('home-date'), app: $('app') };
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let registry = { dock: [], grid: [], apps: {} };   // web/apps.json
const modules = new Map();                           // id -> Promise<module default export>
const cssLoaded = new Set();
let current = null;                                  // { id, sub, root, inst }
let pendingOrigin = null;                            // tile centre for the next open animation
let busy = false;                                    // an open/close animation is running
let chain = Promise.resolve();                       // route() calls run one after another
let loadedBuild = null;
let pendingReload = false;
let versionInflight = false;
let midnightTimer = 0;

// ---------------------------------------------------------------- history bookkeeping

// Every history entry gets a running index in history.state so back() can tell whether the
// previous entry was inside the same app (then history.back()) or somewhere else (then home).
let hIdx = 0;
let maxIdx = 0;
const entries = new Map(); // idx -> { hash, id }

function trackHistory() {
  const st = history.state;
  if (st && typeof st.jdIdx === 'number') {
    hIdx = st.jdIdx;
  } else {
    hIdx = maxIdx + 1;
    try {
      history.replaceState({ ...(st || {}), jdIdx: hIdx }, '');
    } catch { /* ignore */ }
  }
  maxIdx = Math.max(maxIdx, hIdx);
  entries.set(hIdx, { hash: location.hash, id: parseHash(location.hash).id });
}

// '#/notes/42' -> { id: 'notes', sub: '42' }; '#/' / '' -> { id: null, sub: '' }
export function parseHash(hash) {
  let s = String(hash || '');
  if (s.startsWith('#')) s = s.slice(1);
  if (!s.startsWith('/')) s = `/${s}`;
  const parts = s.slice(1).split('/');
  const id = parts.shift() || '';
  let sub = parts.join('/');
  try {
    sub = decodeURIComponent(sub);
  } catch { /* keep raw */ }
  return id ? { id, sub } : { id: null, sub: '' };
}

Object.assign(nav, {
  go(hash) {
    const h = normalizeHash(hash);
    if (h === location.hash) route();
    else location.hash = h;
  },
  replace(hash) {
    const h = normalizeHash(hash);
    if (h === location.hash) return;
    try {
      history.replaceState(history.state, '', h);
    } catch {
      location.hash = h;
      return;
    }
    entries.set(hIdx, { hash: h, id: parseHash(h).id });
    route();
  },
  back() {
    const prev = entries.get(hIdx - 1);
    if (prev && current && prev.id === current.id) history.back();
    else nav.home();
  },
  home() {
    const prev = entries.get(hIdx - 1);
    if (prev && prev.id === null && current) history.back();
    else if (location.hash !== '#/') location.hash = '#/';
  },
});

// ---------------------------------------------------------------- home screen

function tileButton(id) {
  const meta = registry.apps[id] || { label: id, color: '#8e8e93' };
  const tile = el('span', { class: `tile${meta.tile === 'calendar' ? ' tile-calendar' : ''}` });
  if (meta.tile === 'calendar') {
    tile.append(el('span', { class: 'cal-wd' }), el('span', { class: 'cal-day' }));
  } else {
    tile.style.background = meta.color || '#8e8e93';
    tile.append(el('img', { class: 'glyph', src: `/icons/app-${id}.svg`, alt: '', draggable: 'false' }));
  }
  tile.append(el('span', { class: 'badge', hidden: true }));
  const btn = el('button', { class: 'tile-btn', type: 'button', dataset: { id }, 'aria-label': meta.label }, tile,
    el('span', { class: 'tile-label', text: meta.label }));
  btn.addEventListener('click', () => onTileTap(id, tile));
  return btn;
}

function onTileTap(id, tile) {
  if (busy || current) return;
  haptic('light');
  const r = tile.getBoundingClientRect();
  pendingOrigin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  nav.go(`#/${id}`);
}

function renderHome() {
  els.grid.replaceChildren(...registry.grid.filter((id) => registry.apps[id]).map(tileButton));
  els.dock.replaceChildren(...registry.dock.filter((id) => registry.apps[id]).map(tileButton));
  updateDate();
}

function updateDate() {
  const now = new Date();
  els.date.textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  for (const wd of document.querySelectorAll('.tile-calendar .cal-wd')) wd.textContent = now.toLocaleDateString(undefined, { weekday: 'short' });
  for (const day of document.querySelectorAll('.tile-calendar .cal-day')) day.textContent = String(now.getDate());
  clearTimeout(midnightTimer);
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2);
  midnightTimer = setTimeout(updateDate, Math.max(1000, next - now));
}

function setBadge(id, count) {
  const n = Number(count);
  for (const btn of document.querySelectorAll(`.tile-btn[data-id="${id}"]`)) {
    const badge = btn.querySelector('.badge');
    if (!badge) continue;
    if (Number.isFinite(n) && n > 0) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }
}

function refreshBadges() {
  if (current || document.hidden) return;
  for (const [id, meta] of Object.entries(registry.apps)) {
    if (!meta || typeof meta.badge !== 'string') continue;
    api(meta.badge, { timeout: 5000 }).then((data) => setBadge(id, data && data.count)).catch(() => {});
  }
}

// ---------------------------------------------------------------- app lifecycle

function ensureCss(id) {
  if (cssLoaded.has(id)) return Promise.resolve();
  cssLoaded.add(id);
  return new Promise((resolve) => {
    const link = el('link', { rel: 'stylesheet', href: `/apps/${id}/styles.css`, 'on:load': resolve, 'on:error': resolve });
    document.head.append(link);
    setTimeout(resolve, 1500);
  });
}

// Resolves the app module ({ mount, unmount, route }). Rejects with .notBuilt = true when
// web/apps/<id>/index.js does not exist (the other builders have not shipped it yet).
function loadModule(id) {
  if (!modules.has(id)) {
    const p = (async () => {
      const url = `/apps/${id}/index.js`;
      let head;
      try {
        head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      } catch {
        throw Object.assign(new Error('network'), { network: true });
      }
      if (head.status === 404) throw Object.assign(new Error('not built'), { notBuilt: true });
      const cssReady = ensureCss(id);
      const mod = (await import(url)).default;
      if (!mod || typeof mod.mount !== 'function') throw new Error(`${url} has no mount()`);
      await cssReady;
      return mod;
    })();
    p.catch(() => modules.delete(id)); // a failed load is retried next time
    modules.set(id, p);
  }
  return modules.get(id);
}

function makeCtx(id, sub) {
  return { id, sub, nav, kit };
}

function unmount(entry) {
  if (!entry) return;
  try {
    if (entry.inst && typeof entry.inst.unmount === 'function') entry.inst.unmount();
  } catch (err) {
    console.error(`[launcher] ${entry.id}.unmount() threw`, err);
  }
  entry.root.remove();
}

function waitAnimation(node, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    node.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, ms + 80);
  });
}

async function openApp(id, sub, origin) {
  const layer = els.app;
  const meta = registry.apps[id] || { label: id };
  busy = true;
  layer.replaceChildren();
  layer.scrollTop = 0;
  layer.hidden = false;
  const root = el('div', { class: `app-${id} app-root` });
  layer.append(root);
  current = { id, sub, root, inst: null };
  document.body.classList.add('app-open');

  const animate = Boolean(origin) && !reducedMotion;
  let animation = Promise.resolve();
  if (animate) {
    layer.style.transformOrigin = `${origin.x}px ${origin.y}px`;
    layer.classList.remove('closing');
    layer.classList.add('opening');
    els.home.classList.add('dim');
    animation = waitAnimation(layer, ANIM_MS).then(() => {
      layer.classList.remove('opening');
      if (current && current.root === root) els.home.classList.add('behind');
    });
  } else {
    els.home.classList.add('dim', 'behind');
  }

  let mod;
  try {
    mod = await loadModule(id);
  } catch (err) {
    if (current && current.root === root) {
      if (err && err.notBuilt) toast('Not built yet');
      else if (err && err.network) toast("Can't reach the PC", { kind: 'error' });
      else {
        console.error(`[launcher] ${id} failed to load`, err);
        toast(`${meta.label} failed to load`, { kind: 'error' });
      }
      await animation;
      busy = false;
      await closeApp();
      if (location.hash !== '#/') nav.replace('#/');
    }
    busy = false;
    return;
  }
  if (!current || current.root !== root) {
    busy = false;
    return; // superseded by a newer navigation
  }
  current.inst = mod;
  try {
    await mod.mount(root, makeCtx(id, sub));
  } catch (err) {
    console.error(`[launcher] ${id}.mount() threw`, err);
    toast(`${meta.label} failed to open`, { kind: 'error' });
  }
  await animation;
  busy = false;
}

async function closeApp() {
  const layer = els.app;
  const prev = current;
  current = null;
  document.body.classList.remove('app-open');
  if (layer.hidden) {
    els.home.classList.remove('dim', 'behind');
    return;
  }
  busy = true;
  els.home.classList.remove('behind');
  if (!reducedMotion) {
    layer.classList.remove('opening');
    layer.classList.add('closing');
    els.home.classList.remove('dim');
    await waitAnimation(layer, ANIM_MS);
    layer.classList.remove('closing');
  } else {
    els.home.classList.remove('dim');
  }
  unmount(prev);
  layer.hidden = true;
  layer.replaceChildren();
  busy = false;
}

async function doRoute() {
  trackHistory();
  const { id, sub } = parseHash(location.hash);

  if (!id) {
    if (current) await closeApp();
    else els.home.classList.remove('dim', 'behind');
    refreshBadges();
    return;
  }
  if (!registry.apps[id]) {
    toast('No such app');
    nav.replace('#/');
    return;
  }
  if (current && current.id === id) {
    current.sub = sub;
    const inst = current.inst;
    if (!inst) return; // still loading; mount() will receive the latest sub via ctx below
    if (typeof inst.route === 'function') {
      try {
        await inst.route(sub);
      } catch (err) {
        console.error(`[launcher] ${id}.route() threw`, err);
      }
    } else {
      const root = el('div', { class: `app-${id} app-root` });
      const old = current;
      unmount(old);
      els.app.append(root);
      els.app.scrollTop = 0;
      current = { id, sub, root, inst };
      try {
        await inst.mount(root, makeCtx(id, sub));
      } catch (err) {
        console.error(`[launcher] ${id}.mount() threw`, err);
      }
    }
    return;
  }
  if (current) {
    // Jumping straight from one app to another (deep link): swap without the home animation.
    unmount(current);
    current = null;
  }
  const origin = pendingOrigin;
  pendingOrigin = null;
  await openApp(id, sub, origin);
}

function route() {
  chain = chain.then(doRoute).catch((err) => {
    console.error('[launcher] route failed', err);
    busy = false;
  });
  return chain;
}

// ---------------------------------------------------------------- build-change reload

async function pollVersion() {
  if (versionInflight) return;
  versionInflight = true;
  try {
    const v = await api('/api/version');
    if (loadedBuild === null) {
      loadedBuild = v.build;
    } else if (v.build !== loadedBuild) {
      pendingReload = true;
      maybeReload();
    }
  } catch {
    /* banner + backoff handle it */
  } finally {
    versionInflight = false;
  }
}

// Never yank the keyboard away mid-sentence or kill an upload: a held reload waits for the
// holds to clear (kit fires jakesdata:holds) or the next poll.
function maybeReload() {
  if (!pendingReload || kit.reloadHeld()) return;
  pendingReload = false;
  location.reload();
}

function refreshAll() {
  if (document.hidden) return;
  updateDate();
  pollVersion();
  refreshBadges();
}

window.addEventListener('jakesdata:holds', (event) => {
  if (!event.detail || !event.detail.held) setTimeout(maybeReload, 250);
});

setInterval(() => {
  if (document.hidden) return;
  pollVersion();
  refreshBadges();
}, POLL_MS);

window.addEventListener('jakesdata:foreground', refreshAll);
window.addEventListener('jakesdata:online', refreshAll);
window.addEventListener('online', refreshAll);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshAll();
});

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    const res = await fetch('/apps.json', { cache: 'no-store' });
    const data = await res.json();
    if (data && typeof data === 'object' && data.apps) {
      registry = { dock: Array.isArray(data.dock) ? data.dock : [], grid: Array.isArray(data.grid) ? data.grid : [], apps: data.apps };
    }
  } catch (err) {
    console.error('[launcher] apps.json', err);
    toast("Couldn't load apps.json", { kind: 'error' });
  }
  renderHome();
  window.addEventListener('hashchange', route);
  await route();
  pollVersion();
}

boot();
