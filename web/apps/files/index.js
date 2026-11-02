// Files app: a read-only browser of the PC folders in config.json `fileRoots`.
//   #/files                      the roots list
//   #/files/<root>/<a>/<b>       a folder (or a file: image / video / audio / text preview, else name + size)
// The nav bar title is the breadcrumb (left-truncated to fit); ‹ Back goes up exactly one
// level. Data: /api/files/roots, /list, /get (Range-capable, used by <img>/<video>), /text.
// The build-change reload is held while a video or audio preview is playing.
import * as kit from '../../kit.js';

const { api, el, fmt, toast, haptic, navbar, section, emptyState, holdReload, releaseReload, icon, nav } = kit;

const HOLD_KEY = 'files:playing';
const LOADING_DELAY_MS = 300;   // show "Loading…" only when the PC is slow to answer
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'heif', 'bmp', 'svg']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'oga']);
const TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'json', 'jsonl', 'ndjson', 'log', 'csv', 'tsv', 'yaml', 'yml',
  'xml', 'html', 'htm', 'xhtml', 'css', 'js', 'mjs', 'cjs', 'ts', 'py', 'sh', 'bash', 'zsh', 'fish',
  'toml', 'ini', 'cfg', 'conf', 'config', 'env', 'sql', 'srt', 'vtt', 'ass', 'rst', 'tex', 'bib',
  'c', 'h', 'cc', 'cpp', 'hpp', 'java', 'kt', 'swift', 'rb', 'go', 'rs', 'php', 'pl', 'lua', 'r',
  'm', 'mm', 'plist', 'service', 'desktop', 'diff', 'patch', 'properties', 'gitignore', 'editorconfig',
  'nfo', 'lrc', 'cue', 'm3u', 'm3u8',
]);
const TEXT_NAMES = new Set(['readme', 'license', 'licence', 'copying', 'makefile', 'changelog', 'dockerfile', 'authors', 'notice', 'todo', 'version']);
const WRAP_EXT = new Set(['txt', 'text', 'md', 'markdown', 'rst']);

let state = null;
let listeners = [];

export default {
  mount(root, ctx) {
    state = {
      root,                       // the app root element
      sub: '',                    // the current sub-route
      seq: 0,                     // bumps on every navigation; late responses are dropped
      ctrl: null,                 // AbortController of the in-flight request(s)
      roots: null,                // [{ name, exists }] once fetched
      listings: new Map(),        // 'root\0path' -> { entries, truncated } (a file view finds its entry here; back renders instantly)
      scroll: new Map(),          // 'root\0path' -> scrollTop of the folder view, restored on back
      loadingTimer: 0,
      failed: false,
    };
    show(ctx.sub);
    listen(window, 'jakesdata:online', () => { if (state && state.failed) show(state.sub); });
  },

  route(sub) {
    show(sub);
  },

  unmount() {
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners = [];
    if (state) {
      clearTimeout(state.loadingTimer);
      if (state.ctrl) state.ctrl.abort();
    }
    releaseReload(HOLD_KEY);
    state = null;
  },
};

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  listeners.push([target, type, fn]);
}

// ---------------------------------------------------------------- routing

// '<root>/<a>/<b>' (already decoded by the launcher) -> { rootName, segments }
function parseSub(sub) {
  const parts = String(sub || '').split('/').filter((p) => p !== '' && p !== '.');
  const rootName = parts.shift() || '';
  return { rootName, segments: parts };
}

function hashFor(rootName, segments = []) {
  if (!rootName) return '#/files';
  return `#/files/${encodeURIComponent(rootName)}${segments.map((s) => `/${encodeURIComponent(s)}`).join('')}`;
}

function apiPath(route, rootName, segments) {
  return `/api/files/${route}?root=${encodeURIComponent(rootName)}&path=${encodeURIComponent(segments.join('/'))}`;
}

function cacheKey(rootName, segments) {
  return `${rootName}\0${segments.join('/')}`;
}

function layer() {
  return document.getElementById('app');
}

function show(sub) {
  if (!state) return;
  rememberScroll();
  state.sub = String(sub || '');
  state.seq += 1;
  state.failed = false;
  clearTimeout(state.loadingTimer);
  if (state.ctrl) state.ctrl.abort();
  state.ctrl = new AbortController();
  releaseReload(HOLD_KEY); // whatever was playing is being replaced
  const { rootName, segments } = parseSub(state.sub);
  if (!rootName) showRoots();
  else showPath(rootName, segments);
}

// The folder view just left keeps its scroll position for when ‹ Back returns to it.
function rememberScroll() {
  if (!state || !state.current || state.current.kind !== 'dir') return;
  const scroller = layer();
  if (scroller) state.scroll.set(cacheKey(state.current.rootName, state.current.segments), scroller.scrollTop);
}

// Replaces the whole screen: nav bar (rebuilt so the back label matches the depth) + content.
function screen({ crumbs, back, onBack, kind, rootName, segments }, ...children) {
  const header = navbar({ title: crumbs[crumbs.length - 1] || 'Files', back, onBack });
  const content = el('div', { class: 'app-content' }, ...children);
  state.root.replaceChildren(header, content);
  state.current = { kind, rootName, segments };
  fitTitle(header.querySelector('.nav-title'), crumbs);
  const scroller = layer();
  if (scroller) scroller.scrollTop = kind === 'dir' ? (state.scroll.get(cacheKey(rootName, segments)) || 0) : 0;
  return content;
}

// Breadcrumb that keeps its tail: "Videos › pocket3-vlog › vlogs", dropping leading parts
// behind an ellipsis until the text fits the nav bar's title slot.
function fitTitle(titleEl, crumbs) {
  if (!titleEl) return;
  let parts = crumbs.slice();
  titleEl.textContent = parts.join(' › ');
  while (parts.length > 1 && titleEl.scrollWidth > titleEl.clientWidth) {
    parts = parts.slice(1);
    titleEl.textContent = `… › ${parts.join(' › ')}`;
  }
}

function loadingSoon(content) {
  clearTimeout(state.loadingTimer);
  state.loadingTimer = setTimeout(() => {
    if (state && content.isConnected && !content.childElementCount) content.append(emptyState('Loading…'));
  }, LOADING_DELAY_MS);
}

function errorBlock(message, retry) {
  return el('div', { class: 'problem' },
    emptyState(message),
    retry ? el('button', { class: 'button', type: 'button', text: 'Try again', 'on:click': retry }) : null);
}

function failureMessage(err, what) {
  if (err && err.status === 404) return `${what} not found`;
  if (err && err.status) return err.message;
  return "Can't reach the PC";
}

// ---------------------------------------------------------------- roots

async function showRoots() {
  const seq = state.seq;
  const content = screen({ crumbs: ['Files'], back: false, kind: 'roots', rootName: '', segments: [] });
  loadingSoon(content);
  let roots;
  try {
    roots = await api('/api/files/roots', { signal: state.ctrl.signal });
    state.roots = Array.isArray(roots) ? roots : [];
  } catch (err) {
    if (!state || seq !== state.seq) return;
    clearTimeout(state.loadingTimer);
    state.failed = true;
    content.replaceChildren(errorBlock(failureMessage(err, 'Folders'), () => show(state.sub)));
    return;
  }
  if (!state || seq !== state.seq) return;
  clearTimeout(state.loadingTimer);
  const list = Array.isArray(roots) ? roots : [];
  if (!list.length) {
    content.replaceChildren(emptyState('No folders are configured. Add some to fileRoots in server/config.json on the PC.'));
    return;
  }
  const rows = list.map((root) => {
    const exists = Boolean(root.exists);
    const glyph = icon('folder');
    glyph.classList.add('glyph', 'folder');
    return el('button', {
      class: `row tappable${exists ? '' : ' missing'}`,
      type: 'button',
      'on:click': () => {
        if (!exists) {
          toast('That folder does not exist on the PC');
          return;
        }
        haptic('light');
        nav.go(hashFor(String(root.name)));
      },
    }, glyph, el('span', { class: 'label', text: String(root.name) }), exists ? el('span', { class: 'right', text: '' }) : el('span', { class: 'right', text: 'Not found' }), chevron(exists));
  });
  content.replaceChildren(section('Folders'), el('div', { class: 'card' }, ...rows));
}

function chevron(visible = true) {
  const c = icon('chevron-right', { size: 20 });
  c.classList.add('chev');
  if (!visible) c.style.visibility = 'hidden';
  return c;
}

// ---------------------------------------------------------------- folders + files

// Whether a path is a folder or a file is decided from its parent's listing, walking down
// from the root through the cached listings (a tap from a folder view costs nothing extra;
// a cold deep link fetches each level once). The API is never asked to list a file or a
// missing path, so a wrong guess is not a 4xx in the console.
async function showPath(rootName, segments) {
  const seq = state.seq;
  const key = cacheKey(rootName, segments);
  const cached = state.listings.get(key);
  const content = screen({ crumbs: [rootName, ...segments], back: true, onBack: () => goUp(rootName, segments), kind: cached ? 'dir' : 'pending', rootName, segments });
  if (cached) renderFolder(content, rootName, segments, cached);
  else loadingSoon(content);

  let found;
  try {
    found = await resolvePath(rootName, segments);
  } catch (err) {
    if (!state || seq !== state.seq) return;
    clearTimeout(state.loadingTimer);
    state.listings.delete(key);
    state.failed = !err || !err.status;
    content.replaceChildren(errorBlock(failureMessage(err, 'Folder'), () => show(state.sub)));
    return;
  }
  if (!state || seq !== state.seq) return;
  clearTimeout(state.loadingTimer);
  if (found.kind === 'missing') {
    state.listings.delete(key);
    content.replaceChildren(errorBlock(`${found.what} not found`, () => show(state.sub)));
    return;
  }
  if (found.kind === 'file') {
    renderFile(content, rootName, segments, found.entry, seq);
    return;
  }
  const same = cached && JSON.stringify(cached) === JSON.stringify(found.listing);
  state.listings.set(key, found.listing);
  if (!same) renderFolder(content, rootName, segments, found.listing);
}

async function getRoots() {
  if (!state.roots) {
    const roots = await api('/api/files/roots', { signal: state.ctrl.signal });
    if (!state) throw new Error('unmounted');
    state.roots = Array.isArray(roots) ? roots : [];
  }
  return state.roots;
}

// The listing of a folder, from the cache unless `fresh` (the folder being displayed is
// always re-fetched; the folders passed through on the way down may be a little stale).
async function getListing(rootName, segments, fresh) {
  const key = cacheKey(rootName, segments);
  if (!fresh && state.listings.has(key)) return state.listings.get(key);
  const data = await api(apiPath('list', rootName, segments), { signal: state.ctrl.signal });
  if (!state) throw new Error('unmounted');
  const listing = { entries: Array.isArray(data.entries) ? data.entries : [], truncated: Boolean(data.truncated) };
  state.listings.set(key, listing);
  return listing;
}

// -> { kind: 'dir', listing } | { kind: 'file', entry } | { kind: 'missing', what: 'Folder' | 'File' }
async function resolvePath(rootName, segments) {
  const roots = await getRoots();
  const root = roots.find((r) => String(r.name) === rootName);
  if (!root || !root.exists) return { kind: 'missing', what: 'Folder' };
  const last = segments.length - 1;
  let listing = await getListing(rootName, [], last < 0);
  for (let i = 0; i <= last; i++) {
    const name = segments[i];
    let entry = listing.entries.find((e) => e.name === name);
    if (!entry && listing.truncated) entry = await probeBeyondCap(rootName, segments.slice(0, i + 1));
    if (!entry) return { kind: 'missing', what: i === last ? 'File or folder' : 'Folder' };
    if (entry.kind === 'file') return i === last ? { kind: 'file', entry } : { kind: 'missing', what: 'Folder' };
    listing = await getListing(rootName, segments.slice(0, i + 1), i === last);
  }
  return { kind: 'dir', listing };
}

// A name past the 5,000-entry listing cap is invisible in the parent listing; ask the API
// directly (a file answers "not a directory", which here is an answer, not an error).
async function probeBeyondCap(rootName, segments) {
  const name = segments[segments.length - 1];
  try {
    await getListing(rootName, segments, true);
    return { name, kind: 'dir', size: 0, mtime: null, ext: '', count: null };
  } catch (err) {
    if (err && err.status === 400 && /not a directory/i.test(err.message)) {
      const dot = name.lastIndexOf('.');
      return { name, kind: 'file', size: null, mtime: null, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' };
    }
    if (err && err.status === 404) return null;
    throw err;
  }
}

function goUp(rootName, segments) {
  nav.go(segments.length ? hashFor(rootName, segments.slice(0, -1)) : hashFor(''));
}

function renderFolder(content, rootName, segments, listing) {
  state.current = { kind: 'dir', rootName, segments };
  const { entries, truncated } = listing;
  if (!entries.length) {
    content.replaceChildren(emptyState('Empty folder'));
    return;
  }
  const rows = entries.map((entry) => {
    const isDir = entry.kind === 'dir';
    const glyph = icon(isDir ? 'folder' : glyphFor(entry));
    glyph.classList.add('glyph', isDir ? 'folder' : 'file');
    return el('button', {
      class: 'row tappable',
      type: 'button',
      'on:click': () => {
        haptic('light');
        nav.go(hashFor(rootName, [...segments, entry.name]));
      },
    },
    glyph,
    el('span', { class: 'label', text: entry.name }),
    el('span', { class: 'right', text: isDir ? itemCount(entry.count) : fmt.bytes(entry.size) }),
    chevron(isDir));
  });
  content.replaceChildren(el('div', { class: 'card' }, ...rows));
  if (truncated) content.append(el('p', { class: 'note', text: `Showing the first ${entries.length.toLocaleString()} items` }));
  const scroller = layer();
  if (scroller) scroller.scrollTop = state.scroll.get(cacheKey(rootName, segments)) || 0;
}

function itemCount(count) {
  if (typeof count !== 'number') return '';
  return count === 1 ? '1 item' : `${count.toLocaleString()} items`;
}

function glyphFor(entry) {
  const ext = String(entry.ext || '').toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'play';
  if (isTextish(entry.name, ext)) return 'text';
  return 'file';
}

function isTextish(name, ext) {
  if (ext) return TEXT_EXT.has(ext);
  return TEXT_NAMES.has(String(name).toLowerCase());
}

function renderFile(content, rootName, segments, entry, seq) {
  state.current = { kind: 'file', rootName, segments };
  const ext = String(entry.ext || '').toLowerCase();
  const src = apiPath('get', rootName, segments);
  const preview = el('div', { class: 'preview' });
  let kindLabel = 'File';

  if (IMAGE_EXT.has(ext)) {
    kindLabel = 'Image';
    const img = el('img', { src, alt: entry.name, decoding: 'async' });
    img.addEventListener('error', () => preview.replaceChildren(noPreview(entry, 'image', "This image can't be shown here")));
    preview.append(img);
  } else if (VIDEO_EXT.has(ext)) {
    kindLabel = 'Video';
    const video = el('video', { src, controls: true, playsinline: true, preload: 'metadata' });
    wirePlayback(video);
    video.addEventListener('error', () => preview.replaceChildren(noPreview(entry, 'video', "This video can't play here")));
    preview.append(video);
  } else if (AUDIO_EXT.has(ext)) {
    kindLabel = 'Audio';
    const audio = el('audio', { src, controls: true, preload: 'metadata' });
    wirePlayback(audio);
    audio.addEventListener('error', () => preview.replaceChildren(noPreview(entry, 'play', "This audio can't play here")));
    preview.append(el('div', { class: 'audio-box' }, audio));
  } else if (isTextish(entry.name, ext)) {
    kindLabel = 'Text';
    preview.append(emptyState('Loading…'));
    loadText(preview, rootName, segments, entry, seq);
  } else {
    preview.append(noPreview(entry, 'file', 'No preview'));
  }

  const kv = (label, value, mono = false) => el('div', { class: 'kv' }, el('span', { class: 'k', text: label }), el('span', { class: mono ? 'v mono' : 'v', text: value }));
  const details = el('div', { class: 'card details' },
    kv('Name', entry.name),
    kv('Size', fmt.bytes(entry.size)),
    kv('Modified', fmt.date(entry.mtime, { time: true })),
    kv('Kind', ext ? `${kindLabel} · ${ext.toUpperCase()}` : kindLabel));
  content.replaceChildren(preview, section('Details'), details);
}

function noPreview(entry, glyphName, text) {
  const glyph = icon(glyphName, { size: 40, strokeWidth: 1.6 });
  return el('div', { class: 'nopreview' },
    glyph,
    el('div', { class: 'name', text: entry.name }),
    el('div', { class: 'meta', text: `${fmt.bytes(entry.size)} · ${text}` }));
}

// Never reload the app mid-playback (the build-change poll waits for the hold to clear).
function wirePlayback(media) {
  media.addEventListener('play', () => holdReload(HOLD_KEY));
  media.addEventListener('pause', () => releaseReload(HOLD_KEY));
  media.addEventListener('ended', () => releaseReload(HOLD_KEY));
}

async function loadText(preview, rootName, segments, entry, seq) {
  let data;
  try {
    data = await api(apiPath('text', rootName, segments), { signal: state.ctrl.signal, timeout: 15000 });
  } catch (err) {
    if (!state || seq !== state.seq) return;
    preview.replaceChildren(noPreview(entry, 'text', err && err.status ? err.message : "Can't reach the PC"));
    return;
  }
  if (!state || seq !== state.seq) return;
  const ext = String(entry.ext || '').toLowerCase();
  const pre = el('pre', { class: `text${WRAP_EXT.has(ext) ? ' wrap' : ''}`, text: typeof data.text === 'string' ? data.text : '' });
  preview.replaceChildren(pre);
  if (data.truncated) preview.append(el('p', { class: 'note', text: `Showing the first 200 KB of ${fmt.bytes(data.size != null ? data.size : entry.size)}` }));
}
