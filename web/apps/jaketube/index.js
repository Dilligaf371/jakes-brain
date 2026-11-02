// JakeTube: a private YouTube over the PC's video folders. Home (#/jaketube) = channel chips
// + search + a list of cards (16:9 thumb, duration pill, a thin red bar when partly
// watched). Watch (#/jaketube/watch/<id>) = <video controls playsinline autoplay> streamed
// from /api/jaketube/stream/<id> (Range), "Resume from 12:34" when progress exists, progress
// saved every 5 s and on pause/unmount, then "Up next" from the same channel. The reload is
// held while typing in the search field and while a video is playing.
import * as kit from '../../kit.js';

const { api, el, fmt, toast, haptic, navbar, section, emptyState, holdReload, releaseReload, store, debounce, icon, nav } = kit;

const CHANNEL_KEY = 'jaketube.channel';   // the chip that was selected last time
const HOLD_TYPING = 'jaketube:typing';
const HOLD_PLAYING = 'jaketube:playing';
const SAVE_EVERY_MS = 5_000;
const THUMB_RECHECK_MS = 4_000;           // the list is fetched once more when thumbs were still missing
const RESUME_MIN_S = 5;                   // no "Resume from" inside the first 5 s (10 % of a short clip)
const RESUME_TAIL_S = 10;                 // or the last 10 s (5 % of a short clip): that one is watched
const UP_NEXT_MAX = 20;
const WIDE_QUERY = '(min-width: 700px)';  // the watch page takes the whole window on the PC
const ABOUT_LINE = '4K files stream as-is, so over Tailscale they may buffer; LAN is fine.';

let app = null; // { root, view, channel, q, channels, videos, videosKey, homeScroll, listeners, wide }

export default {
  mount(root, ctx) {
    app = {
      root,
      view: null,
      channel: readStoredChannel(),
      q: '',
      channels: null,
      videos: null,
      videosKey: null,
      homeScroll: 0,
      listeners: [],
      wide: window.matchMedia(WIDE_QUERY),
    };
    listen(window, 'jakesdata:online', onRefresh);
    listen(window, 'jakesdata:foreground', onRefresh);
    listen(document, 'visibilitychange', onVisibility);
    if (typeof app.wide.addEventListener === 'function') listen(app.wide, 'change', syncFullBleed);
    showRoute(ctx.sub);
  },

  route(sub) {
    if (app) showRoute(sub);
  },

  unmount() {
    if (!app) return;
    teardownView();
    for (const [target, type, fn] of app.listeners) target.removeEventListener(type, fn);
    app.root.classList.remove('full-bleed');
    app = null;
  },
};

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  app.listeners.push([target, type, fn]);
}

// The #app layer is the scroll container (the launcher owns it); root is its only child.
function scroller() {
  return app.root.parentElement || document.getElementById('app') || document.documentElement;
}

function showRoute(sub) {
  const s = String(sub == null ? '' : sub);
  const m = /^watch\/([0-9a-f]{16})$/.exec(s);
  if (m) showWatch(m[1]);
  else if (!s) showHome();
  else nav.replace('#/jaketube');
}

function onRefresh() {
  if (!app || !app.view || app.view.kind !== 'home') return;
  loadChannels();
  loadList({ quiet: true });
}

function onVisibility() {
  if (!app || !app.view) return;
  if (document.hidden) {
    if (app.view.kind === 'watch') saveProgress(app.view);
  } else if (app.view.kind === 'home') {
    loadList({ quiet: true });
  }
}

function teardownView() {
  const v = app.view;
  if (!v) return;
  app.view = null;
  if (v.kind === 'home') {
    clearTimeout(v.recheck);
    if (v.onInput) v.onInput.cancel();
    releaseReload(HOLD_TYPING);
  } else if (v.kind === 'watch') {
    stopSaving(v);
    saveProgress(v);
    releaseReload(HOLD_PLAYING);
    for (const off of v.off) off();
    v.off = [];
    try { v.video.pause(); } catch { /* never attached */ }
    v.video.removeAttribute('src');
    v.video.removeAttribute('poster');
    try { v.video.load(); } catch { /* ignore */ } // stops the download
  }
}

function syncFullBleed() {
  if (!app) return;
  app.root.classList.toggle('full-bleed', Boolean(app.view && app.view.kind === 'watch' && app.wide.matches));
}

// ---------------------------------------------------------------- home

function readStoredChannel() {
  const value = store.get(CHANNEL_KEY, '');
  return typeof value === 'string' ? value : '';
}

function listKey() {
  return `${app.channel}|${app.q}`;
}

function showHome() {
  if (app.view && app.view.kind === 'home') {
    loadList({ quiet: true });
    return;
  }
  teardownView();
  syncFullBleed();

  const chips = el('div', { class: 'chips tube-chips', role: 'group', 'aria-label': 'Channel' });
  const search = el('input', {
    class: 'input tube-search', type: 'search', placeholder: 'Search', 'aria-label': 'Search videos',
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'search',
  });
  search.value = app.q;
  const list = el('div', { class: 'tube-list' });
  const empty = emptyState('No videos yet.');
  empty.hidden = true;
  const note = el('p', { class: 'tube-note', text: ABOUT_LINE });
  app.root.replaceChildren(
    navbar({ title: 'JakeTube' }),
    el('div', { class: 'app-content tube-home' }, chips, search, list, empty, note),
  );

  const view = { kind: 'home', chips, search, list, empty, cards: new Map(), seq: 0, recheck: 0, rechecked: false, loaded: false, onInput: null };
  app.view = view;

  view.onInput = debounce(() => {
    if (!app || app.view !== view) return;
    const q = search.value.trim();
    if (q === app.q) return;
    app.q = q;
    view.rechecked = false;
    loadList();
  }, 250);
  search.addEventListener('input', () => {
    syncTypingHold(search);
    view.onInput();
  });
  search.addEventListener('focus', () => syncTypingHold(search));
  search.addEventListener('blur', () => releaseReload(HOLD_TYPING));
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      view.onInput.flush();
      search.blur();
    }
  });

  renderChips();
  if (app.videos && app.videosKey === listKey()) {
    view.loaded = true;
    renderList();
  }
  loadChannels();
  loadList();
  requestAnimationFrame(() => {
    if (app && app.view === view) scroller().scrollTop = app.homeScroll;
  });
}

// Never yank the keyboard away mid-search: hold the build-change reload while typing.
function syncTypingHold(input) {
  if (document.activeElement === input && input.value.trim()) holdReload(HOLD_TYPING);
  else releaseReload(HOLD_TYPING);
}

async function loadChannels() {
  try {
    const data = await api('/api/jaketube/channels');
    if (!app) return;
    app.channels = Array.isArray(data) ? data.filter((c) => c && typeof c.id === 'string') : [];
    if (app.channel && !app.channels.some((c) => c.id === app.channel)) {
      // the remembered chip is gone from the config: back to All
      app.channel = '';
      store.del(CHANNEL_KEY);
      if (app.view && app.view.kind === 'home') loadList();
    }
    renderChips();
  } catch {
    /* the chips stay as they are; the banner reports an outage */
  }
}

function renderChips() {
  const v = app.view;
  if (!v || v.kind !== 'home') return;
  const items = [{ id: '', name: 'All' }, ...(app.channels || [])];
  v.chips.replaceChildren(...items.map((c) => el('button', {
    class: 'chip', type: 'button', text: c.name, 'aria-pressed': String(app.channel === c.id),
    'on:click': () => selectChannel(c.id),
  })));
}

function selectChannel(id) {
  if (!app || app.channel === id) return;
  haptic('light');
  app.channel = id;
  if (id) store.set(CHANNEL_KEY, id);
  else store.del(CHANNEL_KEY);
  renderChips();
  if (app.view && app.view.kind === 'home') app.view.rechecked = false;
  loadList();
}

async function loadList({ quiet = false } = {}) {
  const v = app.view;
  if (!v || v.kind !== 'home') return;
  const seq = ++v.seq;
  const key = listKey();
  const params = new URLSearchParams();
  if (app.channel) params.set('channel', app.channel);
  if (app.q) params.set('q', app.q);
  const qs = params.toString();
  try {
    const data = await api(`/api/jaketube/videos${qs ? `?${qs}` : ''}`);
    if (!app || app.view !== v || v.seq !== seq) return;
    app.videos = data && Array.isArray(data.videos) ? data.videos : [];
    app.videosKey = key;
    v.loaded = true;
    renderList();
    // Thumbs are made in the background after a list call: look once more a little later.
    if (!v.rechecked && app.videos.some((x) => x.thumb === null)) {
      v.rechecked = true;
      clearTimeout(v.recheck);
      v.recheck = setTimeout(() => loadList({ quiet: true }), THUMB_RECHECK_MS);
    }
  } catch (err) {
    if (!app || app.view !== v || v.seq !== seq) return;
    if (err && err.status === 400 && app.channel) {
      app.channel = '';
      store.del(CHANNEL_KEY);
      renderChips();
      loadList({ quiet });
      return;
    }
    if (!quiet) {
      toast(err && err.status ? `Couldn't load videos: ${err.message}` : "Couldn't load videos — the PC is unreachable", { kind: 'error' });
    }
  }
}

// Cards are kept by id across refreshes (the 4 s thumb re-fetch, a return from the watch
// page) so images do not flicker; only their thumb/duration/progress are patched.
function renderList() {
  const v = app.view;
  if (!v || v.kind !== 'home') return;
  const videos = app.videos || [];
  const nodes = [];
  const keep = new Set();
  for (const video of videos) {
    let card = v.cards.get(video.id);
    if (!card) {
      card = makeCard(video);
      v.cards.set(video.id, card);
    }
    patchCard(card, video);
    nodes.push(card);
    keep.add(video.id);
  }
  for (const id of [...v.cards.keys()]) if (!keep.has(id)) v.cards.delete(id);
  v.list.replaceChildren(...nodes);
  v.empty.textContent = app.q ? 'No matches.' : 'No videos yet.';
  v.empty.hidden = !(v.loaded && videos.length === 0);
}

function makeCard(video) {
  const thumb = el('div', { class: 'tube-thumb' });
  const title = el('div', { class: 'tube-card-title' });
  const sub = el('div', { class: 'tube-card-sub' });
  const card = el('button', { class: 'tube-card', type: 'button', dataset: { id: video.id } },
    thumb, el('div', { class: 'tube-card-text' }, title, sub));
  card.addEventListener('click', () => {
    haptic('light');
    nav.go(`#/jaketube/watch/${video.id}`);
  });
  card.parts = { thumb, title, sub };
  return card;
}

function patchCard(card, video) {
  const { thumb, title, sub } = card.parts;
  const t = titleOf(video);
  title.textContent = t;
  sub.textContent = subtitleOf(video);
  card.setAttribute('aria-label', video.duration != null ? `${t}, ${fmt.duration(video.duration)}` : t);
  renderThumb(thumb, video);
}

// A 16:9 box: the JPEG (or a muted glyph while the thumb is still being made), the
// duration pill, and the red progress bar when the video was partly watched.
function renderThumb(box, video) {
  const src = video.thumb || '';
  if (box.dataset.src !== src) {
    box.dataset.src = src;
    box.classList.toggle('portrait', isPortrait(video));
    const media = src
      ? el('img', { src, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' })
      : placeholder();
    if (src) media.addEventListener('error', () => media.replaceWith(placeholder()), { once: true });
    const old = box.querySelector('img, .tube-thumb-empty');
    if (old) old.replaceWith(media);
    else box.prepend(media);
  }
  const dur = video.duration != null ? fmt.duration(video.duration) : '';
  let pill = box.querySelector('.tube-dur');
  if (dur) {
    if (!pill) {
      pill = el('span', { class: 'tube-dur' });
      box.append(pill);
    }
    pill.textContent = dur;
  } else if (pill) {
    pill.remove();
  }
  const frac = progressFraction(video);
  let bar = box.querySelector('.tube-progress');
  if (frac > 0) {
    if (!bar) {
      bar = el('div', { class: 'tube-progress' }, el('div', { class: 'tube-progress-fill' }));
      box.append(bar);
    }
    bar.firstChild.style.width = `${Math.round(frac * 1000) / 10}%`;
  } else if (bar) {
    bar.remove();
  }
}

function placeholder() {
  return el('div', { class: 'tube-thumb-empty' }, icon('video', { size: 28, strokeWidth: 1.6 }));
}

function isPortrait(video) {
  return Boolean(video.width && video.height && video.height > video.width);
}

function progressFraction(video) {
  const p = video.progress;
  const d = (p && p.duration) || video.duration;
  if (!p || !d || !(p.seconds >= 1)) return 0;
  return Math.min(1, Math.max(0, p.seconds / d));
}

// ---------------------------------------------------------------- names

// "2026-10-15.mp4" -> "Oct 15, 2026", "2026-10-15_19-07-48.mp4" -> "Oct 15, 2026 · 7:07 PM",
// anything else -> the stem.
function parseDateName(name) {
  const stem = String(name == null ? '' : name).replace(/\.[^.]+$/, '');
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[_T ](\d{2})-(\d{2})-(\d{2}))?$/.exec(stem);
  if (!m) return null;
  const hasTime = m[4] !== undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  const valid = !Number.isNaN(d.getTime())
    && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])
    && (!hasTime || (Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6]) < 60));
  return valid ? { date: d, hasTime } : null;
}

function titleOf(video) {
  const name = String(video.name || '');
  const parsed = parseDateName(name);
  if (parsed) {
    const date = fmt.date(parsed.date, { year: true });
    return parsed.hasTime ? `${date} · ${fmt.time(parsed.date)}` : date;
  }
  const stem = name.replace(/\.[^.]+$/, '');
  return stem || video.title || 'Video';
}

function subtitleOf(video) {
  return `${video.channel_name || video.channel || ''} · ${fmt.bytes(video.size)}`;
}

function metaOf(video) {
  const parts = [video.channel_name || video.channel || ''];
  if (!parseDateName(video.name)) parts.push(fmt.date(video.mtime, { year: true }));
  parts.push(fmt.bytes(video.size));
  if (video.width && video.height) parts.push(`${video.width}×${video.height}`);
  return parts.filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- watch

async function showWatch(id) {
  const current = app.view;
  if (current && current.kind === 'watch' && current.id === id) return;
  if (current && current.kind === 'home') app.homeScroll = scroller().scrollTop;
  teardownView();
  scroller().scrollTop = 0;

  const bar = navbar({ title: 'JakeTube', back: true });
  const video = el('video', {
    class: 'tube-video', controls: true, playsinline: true, 'webkit-playsinline': true, autoplay: true, preload: 'metadata',
  });
  const title = el('h2', { class: 'tube-title' });
  const meta = el('p', { class: 'tube-meta' });
  const resume = el('button', { class: 'tube-resume', type: 'button' });
  resume.hidden = true;
  const notice = el('p', { class: 'tube-notice' });
  notice.hidden = true;
  const upTitle = section('Up next');
  upTitle.hidden = true;
  const upList = el('div', { class: 'tube-upnext' });
  const player = el('div', { class: 'tube-player' }, video);
  app.root.replaceChildren(
    bar,
    el('div', { class: 'app-content tube-watch' },
      player,
      el('div', { class: 'tube-info' }, title, meta, resume, notice),
      el('div', { class: 'tube-aside' }, upTitle, upList)),
  );

  const view = { kind: 'watch', id, bar, video, player, title, meta, resume, notice, upTitle, upList, item: null, gone: false, pendingSeek: null, saveTimer: 0, lastSaved: null, off: [] };
  app.view = view;
  syncFullBleed();
  wireVideo(view);

  // The row first (one quick call): it carries the poster and the saved position, and a
  // bad id becomes a plain "gone" page instead of a failed stream.
  try {
    const data = await api(`/api/jaketube/videos/${id}`);
    if (!app || app.view !== view) return;
    view.item = data && data.video ? data.video : null;
  } catch (err) {
    if (!app || app.view !== view) return;
    view.gone = Boolean(err && err.status === 404);
    player.hidden = true; // nothing to play: no empty black box
    bar.setTitle(view.gone ? 'Gone' : 'JakeTube');
    title.textContent = view.gone ? 'This video is gone' : "Couldn't load this video";
    meta.textContent = view.gone
      ? 'It is no longer in any channel folder.'
      : (err && err.status ? err.message : 'The PC is unreachable.');
    return;
  }
  if (!view.item) return;
  fillWatch(view);                              // poster + "Resume from" (the seek waits for loadedmetadata)
  video.src = `/api/jaketube/stream/${id}`;     // autoplay starts here
  loadUpNext(view);
}

function wireVideo(view) {
  const { video } = view;
  const on = (type, fn) => {
    video.addEventListener(type, fn);
    view.off.push(() => video.removeEventListener(type, fn));
  };
  on('play', () => {
    holdReload(HOLD_PLAYING);
    startSaving(view);
  });
  on('pause', () => {
    releaseReload(HOLD_PLAYING);
    stopSaving(view);
    saveProgress(view);
  });
  on('ended', () => {
    releaseReload(HOLD_PLAYING);
    stopSaving(view);
    saveProgress(view, { ended: true });
  });
  on('loadedmetadata', () => {
    if (view.pendingSeek == null) return;
    const at = view.pendingSeek;
    view.pendingSeek = null;
    seekTo(view, at);
  });
  on('error', () => {
    if (view.gone) return;
    view.notice.textContent = "This file can't be played here.";
    view.notice.hidden = false;
  });
}

function fillWatch(view) {
  const item = view.item;
  const { video } = view;
  const t = titleOf(item);
  view.bar.setTitle(t);
  view.title.textContent = t;
  view.meta.textContent = metaOf(item);
  if (item.thumb && !video.poster) video.poster = item.thumb;

  const p = item.progress;
  const duration = (p && p.duration) || item.duration || 0;
  const minStart = duration ? Math.min(RESUME_MIN_S, duration * 0.1) : RESUME_MIN_S;
  const tail = duration ? Math.min(RESUME_TAIL_S, duration * 0.05) : 0;
  if (p && p.seconds > minStart && (!duration || p.seconds < duration - tail)) {
    view.resume.textContent = `Resume from ${fmt.duration(p.seconds)}`;
    view.resume.hidden = false;
    view.resume.addEventListener('click', () => {
      haptic('light');
      seekTo(view, p.seconds);
      video.play().catch(() => {});
    });
    if (video.readyState >= 1) seekTo(view, p.seconds);
    else view.pendingSeek = p.seconds;
  }
}

function seekTo(view, seconds) {
  try {
    view.video.currentTime = Math.max(0, Number(seconds) || 0);
  } catch {
    /* not seekable yet */
  }
}

function startSaving(view) {
  clearInterval(view.saveTimer);
  view.saveTimer = setInterval(() => saveProgress(view), SAVE_EVERY_MS);
}

function stopSaving(view) {
  clearInterval(view.saveTimer);
  view.saveTimer = 0;
}

// PUT the position (deduped: the same tenth of a second is not sent twice). The cached
// list/item get the new progress too, so the card's bar is right as soon as you go back.
function saveProgress(view, { ended = false } = {}) {
  if (!app || view.gone) return;
  const { video } = view;
  const duration = Number(video.duration);
  if (!Number.isFinite(duration) || duration <= 0) return;
  const seconds = ended ? duration : Number(video.currentTime);
  if (!Number.isFinite(seconds) || (seconds < 1 && !ended)) return;
  const rounded = Math.round(seconds * 10) / 10;
  if (view.lastSaved === rounded) return;
  view.lastSaved = rounded;
  const progress = { seconds: rounded, duration: Math.round(duration * 1000) / 1000, updated_at: new Date().toISOString() };
  if (view.item) view.item.progress = progress;
  if (Array.isArray(app.videos)) {
    for (const v of app.videos) if (v.id === view.id) v.progress = progress;
  }
  api(`/api/jaketube/progress/${view.id}`, { method: 'PUT', body: { seconds: rounded, duration: progress.duration } }).catch(() => {});
}

async function loadUpNext(view) {
  const item = view.item;
  if (!item || !item.channel) return;
  let videos = app.videosKey === `${item.channel}|` && Array.isArray(app.videos) ? app.videos : null;
  if (!videos) {
    try {
      const data = await api(`/api/jaketube/videos?channel=${encodeURIComponent(item.channel)}`);
      if (!app || app.view !== view) return;
      videos = data && Array.isArray(data.videos) ? data.videos : [];
    } catch {
      return;
    }
  }
  const next = videos.filter((v) => v.id !== view.id).slice(0, UP_NEXT_MAX);
  if (!next.length) return;
  view.upTitle.hidden = false;
  view.upList.replaceChildren(...next.map(upNextRow));
}

function upNextRow(video) {
  const thumb = el('div', { class: 'tube-thumb' });
  renderThumb(thumb, video);
  const row = el('button', { class: 'tube-up', type: 'button', 'aria-label': titleOf(video) },
    thumb,
    el('div', { class: 'tube-up-text' },
      el('div', { class: 'tube-up-title', text: titleOf(video) }),
      el('div', { class: 'tube-up-sub', text: subtitleOf(video) })));
  row.addEventListener('click', () => {
    haptic('light');
    nav.go(`#/jaketube/watch/${video.id}`);
  });
  return row;
}
