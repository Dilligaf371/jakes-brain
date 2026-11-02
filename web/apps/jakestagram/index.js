// Jakestagram: Jake's private Instagram. Feed (cards: media, heart, time, caption) and
// Profile (3-column grid) share one newest-first list from /api/jakestagram/posts, paged by
// `before`. `+` opens compose: pick a photo/video, caption, Post (PUT /upload with a
// progress bar, then POST /posts). Delete via the card's "…" sheet.
//
// Sub-routes: ''  feed   'profile'  grid   'new'  compose   'p/<id>'  the feed starting at that post
import * as kit from '../../kit.js';

const {
  api, upload, el, fmt, toast, haptic, confirmSheet, actionSheet, navbar, navButton, emptyState,
  holdReload, releaseReload, icon, nav,
} = kit;

const PAGE = 24;
const MAX_UPLOAD = 300 * 1024 * 1024;
const MEDIA = '/media/jakestagram/';
const USER = 'jake';
const HOLD_COMPOSE = 'jakestagram:compose';
const HOLD_VIDEO = 'jakestagram:video';
const DOUBLE_TAP_MS = 320;
const MEDIA_EXT = /\.(jpe?g|png|gif|webp|heic|mp4|mov|m4v)$/i;
// Instagram's feed crops to between 4:5 (portrait) and 1.91:1 (landscape).
const RATIO_MIN = 0.8;
const RATIO_MAX = 1.91;

let S = null; // app state; null when unmounted

export default {
  mount(root, ctx) {
    S = {
      root,
      ctx,
      view: null,
      viewId: null,
      feed: newList(),            // shared by Feed and Profile
      from: { id: null, ...newList() }, // the "p/<id>" feed
      stats: null,
      scroll: { feed: 0, profile: 0, post: 0 },
      compose: null,              // { file, url, caption, uploading, stage, progress, req, fromApp }
      els: {},
      cards: new Map(),           // id -> card/cell element in the current view
      observer: null,
      playing: new Set(),
      lastTap: { id: 0, at: 0 },
      listeners: [],
    };
    render(parseSub(ctx.sub));
    listen(window, 'jakesdata:online', refresh);
    listen(window, 'jakesdata:foreground', refresh);
    listen(document, 'visibilitychange', () => { if (!document.hidden) refresh(); });
  },

  route(sub) {
    if (S) render(parseSub(sub));
  },

  unmount() {
    if (!S) return;
    teardownView();
    for (const [target, type, fn] of S.listeners) target.removeEventListener(type, fn);
    if (S.compose) {
      if (S.compose.req) S.compose.req.abort();
      if (S.compose.url) URL.revokeObjectURL(S.compose.url);
    }
    releaseReload(HOLD_COMPOSE);
    releaseReload(HOLD_VIDEO);
    S = null;
  },
};

function newList() {
  return { posts: [], more: true, loaded: false, loading: false, error: null };
}

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  S.listeners.push([target, type, fn]);
}

function parseSub(sub) {
  const s = String(sub || '').replace(/^\/+|\/+$/g, '');
  if (s === '') return { view: 'feed' };
  if (s === 'profile') return { view: 'profile' };
  if (s === 'new') return { view: 'compose' };
  const m = /^p\/(\d{1,15})$/.exec(s);
  if (m) return { view: 'post', id: Number(m[1]) };
  return { view: 'feed' };
}

function scrollLayer() {
  return S && S.root ? S.root.parentElement : null; // #app is the scroll container
}

function mediaUrl(name) {
  return MEDIA + encodeURIComponent(name);
}

// ---------------------------------------------------------------- view lifecycle

function render(target) {
  const layer = scrollLayer();
  if (S.view && layer) S.scroll[S.view] = layer.scrollTop;
  teardownView();
  S.view = target.view;
  S.viewId = target.id || null;
  if (target.view === 'feed') renderFeed();
  else if (target.view === 'profile') renderProfile();
  else if (target.view === 'compose') renderCompose();
  else renderPostFeed(target.id);
  if (layer) layer.scrollTop = target.view === 'compose' ? 0 : (S.scroll[target.view] || 0);
}

function teardownView() {
  if (S.observer) {
    S.observer.disconnect();
    S.observer = null;
  }
  for (const video of S.root.querySelectorAll('video')) {
    try { video.pause(); } catch { /* ignore */ }
  }
  S.playing.clear();
  releaseReload(HOLD_VIDEO);
  S.cards.clear();
  S.els = {};
  if (S.view === 'compose' && S.compose && !S.compose.uploading) discardCompose();
}

function currentList() {
  return S.view === 'post' ? S.from : S.feed;
}

function observe(sentinel) {
  if (!('IntersectionObserver' in window)) return;
  S.observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadMore(false);
  }, { rootMargin: '700px 0px' });
  S.observer.observe(sentinel);
}

function segmented(active) {
  const seg = (key, label, hash) => el('button', {
    type: 'button',
    role: 'tab',
    'aria-selected': String(active === key),
    'aria-pressed': String(active === key),
    text: label,
    'on:click': () => {
      if (active === key) return;
      haptic('light');
      nav.replace(hash);
    },
  });
  return el('div', { class: 'segmented gram-segments', role: 'tablist', 'aria-label': 'Jakestagram' },
    seg('feed', 'Feed', '#/jakestagram'), seg('profile', 'Profile', '#/jakestagram/profile'));
}

function topBar(active) {
  const bar = navbar({ title: '', right: [navButton({ icon: 'plus', label: 'New post', onClick: openCompose })] });
  const title = bar.querySelector('.nav-title');
  if (title) title.replaceChildren(segmented(active));
  return bar;
}

function avatar(size = 32) {
  return el('span', { class: `gram-avatar${size > 40 ? ' big' : ''}`, 'aria-hidden': 'true', text: 'J' });
}

// ---------------------------------------------------------------- feed

function renderFeed() {
  const list = el('div', { class: 'gram-list', 'aria-label': 'Posts' });
  const status = el('div', { class: 'gram-status' });
  const sentinel = el('div', { class: 'gram-sentinel' });
  S.root.replaceChildren(topBar('feed'), el('div', { class: 'app-content gram-content' }, list, status, sentinel));
  S.els = { list, status, sentinel };
  paintAll();
  observe(sentinel);
  if (!S.feed.loaded) loadMore(true);
}

function renderPostFeed(id) {
  const bar = navbar({ title: 'Posts', back: true });
  const list = el('div', { class: 'gram-list', 'aria-label': 'Posts' });
  const status = el('div', { class: 'gram-status' });
  const sentinel = el('div', { class: 'gram-sentinel' });
  S.root.replaceChildren(bar, el('div', { class: 'app-content gram-content' }, list, status, sentinel));
  S.els = { list, status, sentinel };
  if (S.from.id !== id) {
    S.from = { id, ...newList() };
    S.scroll.post = 0;
  }
  paintAll();
  observe(sentinel);
  if (!S.from.loaded) loadMore(true);
}

function renderProfile() {
  const name = el('div', { class: 'gram-profile-name', text: 'Jake' });
  const stats = el('div', { class: 'gram-stats' });
  const header = el('div', { class: 'gram-profile' }, avatar(84), el('div', { class: 'gram-profile-meta' }, name, stats));
  const grid = el('div', { class: 'gram-grid', 'aria-label': 'Posts' });
  const status = el('div', { class: 'gram-status' });
  const sentinel = el('div', { class: 'gram-sentinel' });
  S.root.replaceChildren(topBar('profile'), el('div', { class: 'app-content gram-content' }, header, grid, status, sentinel));
  S.els = { list: grid, status, sentinel, stats };
  paintStats();
  paintAll();
  observe(sentinel);
  if (!S.feed.loaded) loadMore(true);
  loadStats();
}

function paintStats() {
  if (!S.els.stats) return;
  const st = S.stats;
  const stat = (n, label) => el('div', { class: 'gram-stat' }, el('b', { text: st ? String(n) : '—' }), el('span', { text: label }));
  S.els.stats.replaceChildren(stat(st ? st.posts : 0, 'posts'), stat(st ? st.liked : 0, 'liked'), stat(st ? st.videos : 0, 'videos'));
}

async function loadStats() {
  try {
    const data = await api('/api/jakestagram/stats');
    if (!S) return;
    S.stats = data;
    paintStats();
  } catch { /* the counts stay as they were */ }
}

function itemFor(post) {
  return S.view === 'profile' ? gridCell(post) : postCard(post);
}

function paintAll() {
  const L = currentList();
  const { list } = S.els;
  if (!list) return;
  S.cards.clear();
  if (L.posts.length) {
    list.replaceChildren(...L.posts.map(itemFor));
  } else if (L.loaded) {
    list.replaceChildren(S.view === 'post'
      ? emptyState('That post is gone.')
      : el('div', { class: 'gram-empty' },
        emptyState('No posts yet.'),
        el('button', { class: 'gram-link', type: 'button', text: 'Post a photo or video', 'on:click': openCompose })));
  } else {
    list.replaceChildren();
  }
  paintStatus();
}

function paintAppend(posts) {
  const { list } = S.els;
  if (!list || !posts.length) return;
  if (currentList().posts.length === posts.length) return paintAll(); // the first page replaces the empty state
  list.append(...posts.map(itemFor));
  paintStatus();
}

function paintStatus() {
  const L = currentList();
  const { status, sentinel } = S.els;
  if (!status) return;
  if (L.loading) {
    status.replaceChildren(el('span', { text: L.posts.length ? 'Loading more…' : 'Loading…' }));
  } else if (L.error) {
    status.replaceChildren(
      el('span', { text: L.error.status ? `Couldn't load posts: ${L.error.message}` : "Can't reach the PC" }),
      el('button', { class: 'gram-link', type: 'button', text: 'Retry', 'on:click': () => loadMore(!L.loaded) }));
  } else {
    status.replaceChildren();
  }
  if (sentinel) sentinel.hidden = !L.more || !L.loaded;
}

async function loadMore(reset) {
  if (!S) return;
  const L = currentList();
  const view = S.view;
  if (L.loading || (!reset && (!L.more || !L.loaded))) return;
  L.loading = true;
  L.error = null;
  paintStatus();
  const q = new URLSearchParams({ limit: String(PAGE) });
  if (!reset && L.posts.length) q.set('before', String(L.posts[L.posts.length - 1].id));
  else if (view === 'post' && S.from.id) q.set('from', String(S.from.id));
  try {
    const data = await api(`/api/jakestagram/posts?${q}`);
    if (!S || currentList() !== L) return;
    const incoming = Array.isArray(data.posts) ? data.posts : [];
    L.more = Boolean(data.more);
    L.loaded = true;
    if (reset) {
      L.posts = incoming;
      paintAll();
    } else {
      const seen = new Set(L.posts.map((p) => p.id));
      const fresh = incoming.filter((p) => !seen.has(p.id));
      L.posts.push(...fresh);
      paintAppend(fresh);
    }
  } catch (err) {
    if (!S || currentList() !== L) return;
    L.error = err;
  } finally {
    if (S && currentList() === L) {
      L.loading = false;
      paintStatus();
    } else {
      L.loading = false;
    }
  }
}

// On coming back online / to the foreground: re-fetch the first page and swap the list only
// when something changed (a post made from another device), keeping scroll + playing videos.
async function refresh() {
  if (!S || S.view === 'compose' || S.view === 'post') return;
  const L = S.feed;
  if (L.loading) return;
  try {
    const data = await api(`/api/jakestagram/posts?limit=${PAGE}`);
    if (!S || S.view === 'compose' || S.view === 'post') return;
    const incoming = Array.isArray(data.posts) ? data.posts : [];
    const same = incoming.length === Math.min(L.posts.length, PAGE)
      && incoming.every((p, i) => L.posts[i] && L.posts[i].id === p.id && L.posts[i].liked === p.liked && L.posts[i].caption === p.caption);
    if (same && L.loaded) return;
    L.posts = incoming;
    L.more = Boolean(data.more);
    L.loaded = true;
    L.error = null;
    paintAll();
    if (S.view === 'profile') loadStats();
  } catch { /* the banner reports the outage */ }
}

// ---------------------------------------------------------------- cards + cells

function ratioFor(post) {
  if (post.width > 0 && post.height > 0) {
    const r = Math.min(RATIO_MAX, Math.max(RATIO_MIN, post.width / post.height));
    return String(Math.round(r * 1000) / 1000);
  }
  return '1';
}

function mediaElement(post) {
  const thumb = post.thumb ? mediaUrl(post.thumb) : null;
  const file = mediaUrl(post.file);
  if (post.kind === 'video') {
    const video = el('video', {
      class: 'gram-video', src: file, poster: thumb, playsinline: true, controls: true, preload: 'metadata',
      'aria-label': post.caption || 'Video',
    });
    video.addEventListener('play', () => onVideoPlay(video));
    video.addEventListener('pause', () => onVideoStop(video));
    video.addEventListener('ended', () => onVideoStop(video));
    return video;
  }
  const img = el('img', {
    class: 'gram-img', src: thumb || file, alt: post.caption || 'Photo', loading: 'lazy', decoding: 'async', draggable: 'false',
  });
  if (thumb) img.addEventListener('error', () => { if (img.src !== location.origin + file) img.src = file; }, { once: true });
  return img;
}

function postCard(post) {
  const bigHeart = el('div', { class: 'gram-bigheart', 'aria-hidden': 'true' }, icon('heart', { size: 96, strokeWidth: 1.5 }));
  const media = el('div', { class: 'gram-media', style: { aspectRatio: ratioFor(post) } }, mediaElement(post), bigHeart);
  if (post.kind === 'image') media.addEventListener('click', () => onMediaTap(post.id));
  const heart = el('button', {
    class: 'gram-heart', type: 'button', 'aria-pressed': String(post.liked), 'aria-label': post.liked ? 'Unlike' : 'Like',
    'on:click': () => toggleLike(post.id),
  }, icon('heart', { size: 26 }));
  const more = el('button', { class: 'gram-more', type: 'button', 'aria-label': 'More', 'on:click': () => postMenu(post.id) }, icon('more'));
  const card = el('article', { class: 'gram-card', dataset: { id: post.id } },
    el('div', { class: 'gram-head' }, avatar(32), el('span', { class: 'gram-user', text: USER }), more),
    media,
    el('div', { class: 'gram-actions' }, heart, el('time', { class: 'gram-time', datetime: post.created_at, text: fmt.relTime(post.created_at) })),
    post.caption
      ? el('div', { class: 'gram-caption' }, el('span', { class: 'gram-user', text: USER }), ' ', el('span', { class: 'gram-caption-text', text: post.caption }))
      : null);
  S.cards.set(post.id, card);
  return card;
}

function gridCell(post) {
  const src = mediaUrl(post.thumb || post.file);
  const img = el('img', { src, alt: post.caption || (post.kind === 'video' ? 'Video' : 'Photo'), loading: 'lazy', decoding: 'async', draggable: 'false' });
  if (post.thumb) img.addEventListener('error', () => { if (post.kind === 'image') img.src = mediaUrl(post.file); }, { once: true });
  const cell = el('button', {
    class: 'gram-cell', type: 'button', dataset: { id: post.id }, 'aria-label': post.caption || (post.kind === 'video' ? 'Video' : 'Photo'),
    'on:click': () => {
      haptic('light');
      nav.go(`#/jakestagram/p/${post.id}`);
    },
  }, img, post.kind === 'video' ? el('span', { class: 'gram-cell-badge' }, icon('video', { size: 18 })) : null);
  S.cards.set(post.id, cell);
  return cell;
}

function findPost(id) {
  return S.feed.posts.find((p) => p.id === id) || S.from.posts.find((p) => p.id === id) || null;
}

function patchPost(id, patch) {
  for (const L of [S.feed, S.from]) {
    const i = L.posts.findIndex((p) => p.id === id);
    if (i >= 0) L.posts[i] = { ...L.posts[i], ...patch };
  }
  const card = S.cards.get(id);
  if (card && patch.liked !== undefined) {
    const heart = card.querySelector('.gram-heart');
    if (heart) {
      heart.setAttribute('aria-pressed', String(patch.liked));
      heart.setAttribute('aria-label', patch.liked ? 'Unlike' : 'Like');
    }
  }
}

function dropPost(id) {
  for (const L of [S.feed, S.from]) L.posts = L.posts.filter((p) => p.id !== id);
  const node = S.cards.get(id);
  if (node) node.remove();
  S.cards.delete(id);
  if (!currentList().posts.length) paintAll();
  S.stats = null;
  if (S.view === 'profile') loadStats();
}

function onMediaTap(id) {
  const now = Date.now();
  if (S.lastTap.id === id && now - S.lastTap.at < DOUBLE_TAP_MS) {
    S.lastTap = { id: 0, at: 0 };
    const card = S.cards.get(id);
    const big = card && card.querySelector('.gram-bigheart');
    if (big) {
      big.classList.remove('show');
      void big.offsetWidth; // restart the animation
      big.classList.add('show');
    }
    const post = findPost(id);
    if (post && !post.liked) toggleLike(id);
    else haptic('light');
    return;
  }
  S.lastTap = { id, at: now };
}

async function toggleLike(id) {
  const post = findPost(id);
  if (!post) return;
  const liked = !post.liked;
  haptic(liked ? 'medium' : 'light');
  patchPost(id, { liked });
  try {
    const data = await api(`/api/jakestagram/posts/${id}`, { method: 'PATCH', body: { liked } });
    if (!S) return;
    patchPost(id, data.post);
    S.stats = null;
  } catch (err) {
    if (!S) return;
    if (err && err.status === 404) {
      dropPost(id);
      toast('That post is gone');
      return;
    }
    patchPost(id, { liked: !liked });
    toast(err && err.status ? `Couldn't save: ${err.message}` : "Couldn't save — the PC is unreachable", { kind: 'error' });
    haptic('error');
  }
}

async function postMenu(id) {
  const choice = await actionSheet({ actions: [{ label: 'Delete', value: 'delete', destructive: true }] });
  if (!S || choice !== 'delete') return;
  const post = findPost(id);
  const ok = await confirmSheet({
    title: 'Delete this post?',
    message: post && post.kind === 'video' ? 'The video is removed from the PC too.' : 'The photo is removed from the PC too.',
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!S || !ok) return;
  try {
    await api(`/api/jakestagram/posts/${id}`, { method: 'DELETE' });
    if (!S) return;
    dropPost(id);
    haptic('success');
    toast('Deleted');
  } catch (err) {
    if (!S) return;
    if (err && err.status === 404) {
      dropPost(id);
      return;
    }
    toast(err && err.status ? `Couldn't delete: ${err.message}` : "Couldn't delete — the PC is unreachable", { kind: 'error' });
    haptic('error');
  }
}

// One video at a time; a playing video holds the build-change reload.
function onVideoPlay(video) {
  if (!S) return;
  for (const other of S.root.querySelectorAll('video')) {
    if (other !== video && !other.paused) other.pause();
  }
  S.playing.add(video);
  holdReload(HOLD_VIDEO);
}

function onVideoStop(video) {
  if (!S) return;
  S.playing.delete(video);
  if (!S.playing.size) releaseReload(HOLD_VIDEO);
}

// ---------------------------------------------------------------- compose

function openCompose() {
  haptic('light');
  if (!S.compose) S.compose = newCompose(true);
  nav.go('#/jakestagram/new');
}

function newCompose(fromApp) {
  return { file: null, url: null, caption: '', uploading: false, stage: '', progress: 0, req: null, fromApp };
}

function discardCompose() {
  const c = S.compose;
  if (!c) return;
  if (c.url) URL.revokeObjectURL(c.url);
  S.compose = null;
  releaseReload(HOLD_COMPOSE);
}

function leaveCompose() {
  const fromApp = S.compose ? S.compose.fromApp : false;
  if (fromApp) nav.back();
  else nav.replace('#/jakestagram');
}

function renderCompose() {
  if (!S.compose) S.compose = newCompose(false);
  const c = S.compose;
  const postBtn = navButton({ label: 'Post', primary: true, onClick: submitPost });
  const bar = navbar({ title: 'New post', back: true, onBack: onComposeBack, right: [postBtn] });
  const input = el('input', { type: 'file', accept: 'image/*,video/*', class: 'gram-file', 'aria-label': 'Choose a photo or video', hidden: true });
  input.addEventListener('change', () => onPick(input));
  const pick = () => { if (!c.uploading) input.click(); };
  const picker = el('button', { class: 'gram-picker', type: 'button', 'on:click': pick },
    icon('image', { size: 40, strokeWidth: 1.6 }), el('span', { text: 'Choose a photo or video' }));
  const preview = el('div', { class: 'gram-preview' });
  const meta = el('span', { class: 'gram-preview-meta' });
  const change = el('div', { class: 'gram-change' }, meta,
    el('button', { class: 'gram-link', type: 'button', text: 'Change', 'on:click': pick }));
  const caption = el('textarea', {
    class: 'input gram-caption-input', placeholder: 'Write a caption…', rows: '3', maxlength: '2200',
    autocapitalize: 'sentences', autocorrect: 'on', 'aria-label': 'Caption', enterkeyhint: 'done',
  });
  caption.value = c.caption;
  caption.addEventListener('input', () => {
    c.caption = caption.value;
    autoGrow(caption);
    syncComposeHold();
  });
  const fill = el('div', { class: 'bar-fill' });
  const progress = el('div', { class: 'bar gram-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill);
  const status = el('div', { class: 'gram-upload-status', 'aria-live': 'polite' });
  const content = el('div', { class: 'app-content gram-compose' }, input, picker, preview, change, caption, progress, status);
  S.root.replaceChildren(bar, content);
  S.els = { postBtn, input, picker, preview, meta, change, caption, progress, fill, status };
  paintCompose();
  syncComposeHold();
}

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(240, textarea.scrollHeight + 2)}px`;
}

function syncComposeHold() {
  const c = S.compose;
  if (c && (c.file || c.caption.trim())) holdReload(HOLD_COMPOSE);
  else releaseReload(HOLD_COMPOSE);
}

function paintCompose() {
  const c = S.compose;
  const e = S.els;
  if (!c || !e.preview) return;
  const hasFile = Boolean(c.file);
  e.picker.hidden = hasFile;
  e.preview.hidden = !hasFile;
  e.change.hidden = !hasFile || c.uploading;
  e.postBtn.disabled = !hasFile || c.uploading;
  e.caption.disabled = c.uploading;
  if (hasFile && e.preview.dataset.url !== c.url) {
    e.preview.dataset.url = c.url;
    const isVideo = c.file.type.startsWith('video/') || /\.(mp4|mov|m4v)$/i.test(c.file.name);
    e.preview.replaceChildren(isVideo
      ? el('video', { src: c.url, playsinline: true, controls: true, muted: true, preload: 'metadata' })
      : el('img', { src: c.url, alt: 'Preview' }));
    e.meta.textContent = `${c.file.name} · ${fmt.bytes(c.file.size)}`;
  }
  autoGrow(e.caption);
  paintProgress();
}

function paintProgress() {
  const c = S.compose;
  const e = S.els;
  if (!c || !e.progress) return;
  e.progress.hidden = !c.uploading;
  const pct = Math.round(c.progress * 100);
  e.fill.style.width = `${pct}%`;
  e.progress.setAttribute('aria-valuenow', String(pct));
  if (!c.uploading) e.status.textContent = '';
  else if (c.stage === 'saving') e.status.textContent = 'Saving…';
  else e.status.textContent = pct >= 100 ? 'Processing…' : `Uploading… ${pct}%`;
}

function onPick(input) {
  const c = S.compose;
  const file = input.files && input.files[0];
  input.value = ''; // picking the same file again must fire change
  if (!c || !file) return;
  const okType = file.type.startsWith('image/') || file.type.startsWith('video/') || MEDIA_EXT.test(file.name);
  if (!okType) {
    toast('Photos and videos only', { kind: 'error' });
    return;
  }
  if (file.size > MAX_UPLOAD) {
    toast(`That file is too big (${fmt.bytes(file.size)}, max 300 MB)`, { kind: 'error' });
    return;
  }
  if (c.url) URL.revokeObjectURL(c.url);
  c.file = file;
  c.url = URL.createObjectURL(file);
  haptic('light');
  paintCompose();
  syncComposeHold();
}

function uploadErrorMessage(err) {
  if (!err || !err.status) return "Couldn't upload — the PC is unreachable";
  if (err.status === 413) return 'That file is too big (max 300 MB)';
  if (err.status === 415) return "The PC doesn't accept that file type";
  return `Couldn't post: ${err.message}`;
}

async function submitPost() {
  const c = S.compose;
  if (!c || !c.file || c.uploading) return;
  c.uploading = true;
  c.stage = 'upload';
  c.progress = 0;
  haptic('light');
  paintCompose();
  const req = upload('/api/jakestagram/upload', c.file, {
    onProgress: (p) => {
      if (!S || S.compose !== c) return;
      c.progress = p;
      paintProgress();
    },
  });
  c.req = req;
  try {
    const data = await req;
    const up = data && data.upload;
    if (!up || !up.file) throw new kit.ApiError('unexpected reply from the PC', 500);
    c.stage = 'saving';
    if (S && S.compose === c) paintProgress();
    const created = await api('/api/jakestagram/posts', {
      method: 'POST',
      body: { file: up.file, thumb: up.thumb, kind: up.kind, width: up.width, height: up.height, caption: c.caption.trim() },
    });
    if (!S) return;
    const post = created.post;
    if (S.feed.loaded) S.feed.posts.unshift(post);
    S.stats = null;
    S.scroll.feed = 0;
    S.scroll.profile = 0;
    c.req = null;
    c.uploading = false;
    haptic('success');
    toast('Posted');
    if (S.view === 'compose' && S.compose === c) {
      S.compose = c; // discardCompose() in teardownView revokes the preview URL
      leaveCompose();
    } else {
      if (c.url) URL.revokeObjectURL(c.url);
      if (S.compose === c) S.compose = null;
      if (S.view === 'feed' || S.view === 'profile') paintAll();
    }
    releaseReload(HOLD_COMPOSE);
  } catch (err) {
    if (!S) return;
    c.uploading = false;
    c.req = null;
    c.progress = 0;
    c.stage = '';
    if (S.compose === c && S.view === 'compose') paintCompose();
    if (err && err.message === 'aborted') return;
    toast(uploadErrorMessage(err), { kind: 'error' });
    haptic('error');
  }
}

async function onComposeBack() {
  const c = S.compose;
  if (c && c.uploading) {
    const cancel = await confirmSheet({ title: 'Cancel this upload?', confirmLabel: 'Cancel upload', cancelLabel: 'Keep uploading', destructive: true });
    if (!S || !cancel) return;
    if (c.req) c.req.abort();
    c.uploading = false;
    leaveCompose();
    return;
  }
  if (c && c.file) {
    const discard = await confirmSheet({ title: 'Discard this post?', confirmLabel: 'Discard', cancelLabel: 'Keep editing', destructive: true });
    if (!S || !discard) return;
  }
  leaveCompose();
}
