// kit.js — shared helpers for every app under web/apps/<id>/. Plain ES module, no build step.
// Apps import it as `import * as kit from '../../kit.js'` (ctx.kit is this same module).
//
// Exports (the contract from SPEC.md, plus a few documented extras at the bottom):
//   api(path, { method, body, timeout, headers, raw, signal })   JSON in/out, throws ApiError { status, message }
//   upload(path, file, { onProgress, headers, timeout })         XHR PUT, resolves JSON, promise has .abort()
//   el(tag, attrs, ...children)   esc(str)   fmt.*   toast()   haptic()   confirmSheet()   navbar()
//   section()   emptyState()   holdReload()/releaseReload()   store   debounce()   renderMarkdownLite()
// Extras: ApiError, nav, actionSheet(), navButton(), icon(), reloadHeld(), isOffline(), shellVersion()
//
// Window events apps may listen to (remove listeners in unmount()):
//   'jakesdata:online'      the PC became reachable again (refetch)
//   'jakesdata:offline'     a request just failed; the banner is up
//   'jakesdata:foreground'  the native shell came back to the foreground
//   'jakesdata:holds'       detail { held } — the set of reload holds changed

const FETCH_TIMEOUT_MS = 8_000;   // a PC that is asleep / off the tailnet blackholes SYNs for ~60 s otherwise
const BACKOFF_START_MS = 2_000;   // unreachable retry: 2s, 4s, 8s, ... max 30s
const BACKOFF_MAX_MS = 30_000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

export class ApiError extends Error {
  constructor(message, status = 0, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

// ---------------------------------------------------------------- native bridge

// window.JakesData = { native: true, version: "1.0 (1)" } is injected by the iOS shell.
// On the Mac it is undefined, so everything here is feature-detected.
export function shellVersion() {
  const jd = window.JakesData;
  return jd && jd.version ? String(jd.version) : 'web';
}

export function isNative() {
  return Boolean(window.JakesData && window.JakesData.native);
}

export function haptic(style = 'light') {
  try {
    const webkit = window.webkit;
    const handler = webkit && webkit.messageHandlers && webkit.messageHandlers.native;
    if (handler && typeof handler.postMessage === 'function') handler.postMessage({ type: 'haptic', style });
  } catch {
    /* not running inside the native shell */
  }
}

// ---------------------------------------------------------------- connectivity (global banner + backoff)

const conn = { offline: false, delay: BACKOFF_START_MS, timer: 0 };

export function isOffline() {
  return conn.offline;
}

function markOffline() {
  if (!conn.offline) {
    conn.offline = true;
    const banner = $('banner');
    if (banner) banner.hidden = false;
    document.body.classList.add('offline');
    window.dispatchEvent(new CustomEvent('jakesdata:offline'));
  }
  if (conn.timer) return;
  const wait = conn.delay;
  conn.delay = Math.min(conn.delay * 2, BACKOFF_MAX_MS);
  conn.timer = setTimeout(() => {
    conn.timer = 0;
    api('/api/health', { timeout: 6000 }).catch(() => {}); // success flips us online, failure reschedules
  }, wait);
}

function markOnline() {
  if (!conn.offline) return;
  conn.offline = false;
  conn.delay = BACKOFF_START_MS;
  if (conn.timer) {
    clearTimeout(conn.timer);
    conn.timer = 0;
  }
  const banner = $('banner');
  if (banner) banner.hidden = true;
  document.body.classList.remove('offline');
  window.dispatchEvent(new CustomEvent('jakesdata:online'));
}

// ---------------------------------------------------------------- api

function requireSignIn(response) {
  const login = response.headers ? response.headers.get('X-JakesData-Sign-In') : response.getResponseHeader('X-JakesData-Sign-In');
  if (response.status !== 401 || login !== '/app-login' || document.getElementById('signin-banner')) return;
  const button = el('button', { type: 'button', text: 'Sign in', 'on:click': async () => {
    if (reloadHeld() && !await confirmSheet({ title: 'Sign in again?', message: 'This reloads the app. Finish or copy any unsaved edits first.', confirmLabel: 'Sign in' })) return;
    location.assign('/app-login' + location.hash);
  } });
  document.body.append(el('div', { id: 'signin-banner', class: 'signin-banner', role: 'alert' },
    el('span', { text: 'Sign in again to save changes.' }), button));
}

// JSON in/out over relative /api paths. Every call is bounded by `timeout`. Throws ApiError:
//   status 0   'network' | 'timeout' | 'aborted' (the PC is unreachable; the banner shows)
//   status n   the server's { error } message (or "HTTP n")
// raw=true returns the Response once headers arrive (for ndjson streams); the timeout then
// covers only the headers, and `signal` (an AbortSignal) still aborts the body.
export async function api(path, { method = 'GET', body, timeout = FETCH_TIMEOUT_MS, headers = {}, raw = false, signal } = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeout);
  const onOuterAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const init = { method, cache: 'no-store', headers: { Accept: 'application/json', ...headers }, signal: ctrl.signal };
  if (body !== undefined) {
    const passthrough = typeof body === 'string' || body instanceof Blob || body instanceof ArrayBuffer || body instanceof FormData || ArrayBuffer.isView(body);
    if (passthrough) {
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  const outerAborted = () => Boolean(signal && signal.aborted);
  let keepListener = false;
  try {
    let res;
    try {
      res = await fetch(path, init);
    } catch {
      if (outerAborted()) throw new ApiError('aborted', 0);
      markOffline();
      throw new ApiError(timedOut ? 'timeout' : 'network', 0);
    }
    markOnline(); // any answer at all means the PC is reachable
    requireSignIn(res);
    if (raw) {
      clearTimeout(timer);
      keepListener = true;
      if (!res.ok) {
        let data = null;
        try { data = await res.json(); } catch { /* not JSON */ }
        throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status, data);
      }
      return res;
    }
    if (res.status === 204) return null;
    let data = null;
    try {
      data = await res.json();
    } catch {
      if (ctrl.signal.aborted) {
        if (outerAborted()) throw new ApiError('aborted', 0);
        markOffline();
        throw new ApiError('timeout', 0);
      }
      data = null;
    }
    if (!res.ok) throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status, data);
    return data;
  } finally {
    clearTimeout(timer);
    if (signal && !keepListener) signal.removeEventListener('abort', onOuterAbort);
  }
}

// XHR PUT of the raw file body. Headers: Content-Type = file.type, X-Filename =
// encodeURIComponent(file.name) (the server decodes it with http.js requestFilename()).
// Resolves the JSON response, rejects ApiError. onProgress(0..1). The returned promise has
// .abort(). Holds the build-change reload while the upload is in flight.
let uploadSeq = 0;
export function upload(path, file, { onProgress, headers = {}, timeout = 180_000, method = 'PUT' } = {}) {
  const xhr = new XMLHttpRequest();
  const holdKey = `upload:${++uploadSeq}`;
  const promise = new Promise((resolve, reject) => {
    holdReload(holdKey);
    xhr.open(method, path, true);
    xhr.timeout = timeout;
    xhr.responseType = 'text';
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Content-Type', (file && file.type) || 'application/octet-stream');
    xhr.setRequestHeader('X-Filename', encodeURIComponent((file && file.name) || 'upload'));
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && typeof onProgress === 'function') onProgress(Math.min(1, event.loaded / event.total));
    });
    xhr.addEventListener('load', () => {
      markOnline();
      requireSignIn(xhr);
      let data = null;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (typeof onProgress === 'function') onProgress(1);
        resolve(data);
      } else {
        reject(new ApiError((data && data.error) || `HTTP ${xhr.status}`, xhr.status, data));
      }
    });
    xhr.addEventListener('error', () => {
      markOffline();
      reject(new ApiError('network', 0));
    });
    xhr.addEventListener('timeout', () => reject(new ApiError('timeout', 0)));
    xhr.addEventListener('abort', () => reject(new ApiError('aborted', 0)));
    xhr.addEventListener('loadend', () => releaseReload(holdKey));
    xhr.send(file);
  });
  promise.abort = () => xhr.abort();
  return promise;
}

// ---------------------------------------------------------------- dom

// el('button', { class: 'x', text: 'Go', 'on:click': fn, dataset: { id: 3 }, style: { color: 'red' }, 'aria-label': 'Go' }, child, ...)
// attrs: class, text, html (already-escaped markup), on:<event>, dataset (object), style (object or string),
// any other key -> attribute (true -> "", false/null/undefined -> skipped). Children: nodes, strings,
// numbers, arrays (flattened); null/false skipped.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on:')) node.addEventListener(key.slice(3), value);
    else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) if (v != null) node.dataset[k] = String(v);
    } else if (key === 'style') {
      if (typeof value === 'string') node.style.cssText = value;
      else Object.assign(node.style, value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
}

export function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Small inline SVG glyphs (24x24, stroke currentColor) for buttons: plus, more, trash, pin,
// search, check, close, chevron-left, chevron-right, chevron-up, chevron-down, refresh,
// play, pause, send, stop, heart, camera, folder, file, image, video, text, edit, calendar.
const ICON_PATHS = {
  plus: 'M12 5v14M5 12h14',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  pin: 'M12 17v4M8 17h8l-1.5-6 1.5-2V5H8v4l1.5 2z',
  search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM21 21l-5.2-5.2',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6L6 18',
  'chevron-left': 'M15 5l-7 7 7 7',
  'chevron-right': 'M9 5l7 7-7 7',
  'chevron-up': 'M5 15l7-7 7 7',
  'chevron-down': 'M5 9l7 7 7-7',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  play: 'M8 5v14l11-7z',
  pause: 'M7 5v14M17 5v14',
  send: 'M12 19V5M5 12l7-7 7 7',
  stop: 'M7 7h10v10H7z',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4',
  video: 'M3 7h13v10H3zM16 10l5-3v10l-5-3',
  text: 'M5 7h14M5 12h14M5 17h8',
  edit: 'M4 20h4l10-10-4-4L4 16zM13 7l4 4',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
};

export function icon(name, { size = 24, strokeWidth = 2 } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon', `icon-${name}`);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICON_PATHS[name] || ICON_PATHS.more);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', String(strokeWidth));
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

// ---------------------------------------------------------------- formatting

function toDate(value) {
  const d = value instanceof Date ? value : new Date(typeof value === 'number' ? value : Date.parse(String(value)));
  return Number.isNaN(d.getTime()) ? null : d;
}

export const fmt = {
  // "now", "5m", "3h", "2d", then "Oct 15" (with the year when it is not this year)
  relTime(iso) {
    const d = toDate(iso);
    if (!d) return '';
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
    return fmt.date(d);
  },
  // fmt.date(x) -> "Nov 2" / "Nov 2, 2025"; options: weekday ('long'|'short'|true), month ('long'|'short'|
  // 'numeric'|true|false), day (true|false), year (true|false; default only when not this year), time (true)
  date(value, { weekday, month, day, year, time } = {}) {
    const d = toDate(value);
    if (!d) return '—';
    const pick = (v, dflt) => (v === true || v === undefined ? dflt : v);
    const o = {};
    if (weekday) o.weekday = pick(weekday, 'long');
    if (month !== false) o.month = pick(month, 'short');
    if (day !== false) o.day = pick(day, 'numeric');
    if (year === true || (year === undefined && d.getFullYear() !== new Date().getFullYear())) o.year = 'numeric';
    if (time) {
      o.hour = 'numeric';
      o.minute = '2-digit';
      o.hour12 = true;
    }
    return d.toLocaleString(undefined, o);
  },
  // "7:07 PM"
  time(value) {
    const d = toDate(value);
    return d ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }) : '—';
  },
  // 65 -> "1:05", 3725 -> "1:02:05"
  duration(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n < 0) return '—';
    const total = Math.round(n);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const two = (x) => String(x).padStart(2, '0');
    return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
  },
  // 1234 -> "1.2 KB", 5e9 -> "5.0 GB"
  bytes(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '—';
    if (v < 1024) return `${Math.round(v)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let x = v / 1024;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) {
      x /= 1024;
      i += 1;
    }
    return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${units[i]}`;
  },
  // local 'YYYY-MM-DD'
  dayKey(value = new Date()) {
    const d = toDate(value) || new Date();
    const two = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  },
};

// ---------------------------------------------------------------- toast + sheets

let toastTimer = 0;
export function toast(message, { kind = 'info', ms = 2200 } = {}) {
  const node = $('toast');
  if (!node) return;
  node.textContent = String(message);
  node.classList.toggle('toast-error', kind === 'error');
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, ms);
}

let closeOpenSheet = null;

// Bottom sheet with a list of actions. Resolves the chosen action's `value` (its label when
// value is undefined), or null when cancelled / tapped outside.
//   actionSheet({ title, message, actions: [{ label, value, destructive, selected }], cancelLabel })
export function actionSheet({ title = '', message = '', actions = [], cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const host = $('sheet');
    if (!host) return resolve(null);
    if (closeOpenSheet) closeOpenSheet(null);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeOpenSheet = null;
      panel.classList.add('out');
      backdrop.classList.add('out');
      setTimeout(() => {
        if (host.contains(panel)) {
          host.hidden = true;
          host.replaceChildren();
        }
      }, 170);
      resolve(value);
    };
    closeOpenSheet = finish;
    const backdrop = el('div', { class: 'sheet-backdrop', 'on:click': () => finish(null) });
    const group = el('div', { class: 'sheet-group' });
    if (title || message) {
      group.append(el('div', { class: 'sheet-head' },
        title ? el('div', { class: 'sheet-title', text: title }) : null,
        message ? el('div', { class: 'sheet-message', text: message }) : null));
    }
    for (const action of actions) {
      group.append(el('button', {
        class: `sheet-action${action.destructive ? ' destructive' : ''}${action.selected ? ' selected' : ''}`,
        type: 'button',
        text: action.label,
        'on:click': () => {
          haptic('light');
          finish(action.value === undefined ? action.label : action.value);
        },
      }));
    }
    const cancel = el('div', { class: 'sheet-group' },
      el('button', { class: 'sheet-action sheet-cancel', type: 'button', text: cancelLabel, 'on:click': () => finish(null) }));
    const panel = el('div', { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Actions' }, group, cancel);
    host.replaceChildren(backdrop, panel);
    host.hidden = false;
  });
}

// Never window.confirm(): the shell has no WKUIDelegate for it. Resolves true/false.
export function confirmSheet({ title = '', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', destructive = false } = {}) {
  return actionSheet({ title, message, actions: [{ label: confirmLabel, value: true, destructive }], cancelLabel })
    .then((value) => value === true);
}

// ---------------------------------------------------------------- navigation + nav bar

// Filled in by launcher.js. go('#/notes/42') pushes history; replace() swaps the current entry;
// back() = history.back() when the previous entry is inside the same app, else home(); home() = '#/'.
export const nav = {
  go(hash) { location.hash = normalizeHash(hash); },
  replace(hash) { location.hash = normalizeHash(hash); },
  back() { nav.home(); },
  home() { location.hash = '#/'; },
};

export function normalizeHash(hash) {
  let h = String(hash == null ? '' : hash).trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (!h.startsWith('/')) h = `/${h}`;
  return `#${h}`;
}

// A nav bar button: navButton({ label: 'Edit' }) or navButton({ icon: 'plus', label: 'New note' }) (icon-only,
// label becomes the aria-label). `primary` makes a text label bold.
export function navButton({ label = '', icon: iconName, onClick, primary = false, disabled = false } = {}) {
  const btn = el('button', {
    class: `nav-btn${primary ? ' primary' : ''}${iconName ? ' icon-only' : ''}`,
    type: 'button',
    'aria-label': iconName ? label || iconName : null,
    disabled,
  }, iconName ? icon(iconName) : label);
  if (typeof onClick === 'function') btn.addEventListener('click', onClick);
  return btn;
}

// Fixed top bar with safe-area padding. Left = ‹ Home (or ‹ Back when back: true), centre
// title, right = optional buttons. The app puts it first in root and pads its content with
// var(--nav-h) (the `.app-content` class does that). The element has setTitle(text).
export function navbar({ title = '', back = false, right = [], onBack } = {}) {
  const backBtn = el('button', { class: 'nav-back', type: 'button', 'aria-label': back ? 'Back' : 'Home' },
    icon('chevron-left', { size: 26, strokeWidth: 2.4 }), el('span', { text: back ? 'Back' : 'Home' }));
  backBtn.addEventListener('click', () => {
    haptic('light');
    if (typeof onBack === 'function') onBack();
    else if (back) nav.back();
    else nav.home();
  });
  const titleEl = el('h1', { class: 'nav-title', text: title });
  const header = el('header', { class: 'navbar' }, backBtn, titleEl, el('div', { class: 'nav-right' }, ...[].concat(right).filter(Boolean)));
  header.setTitle = (text) => { titleEl.textContent = text; };
  return header;
}

export function section(title) {
  return el('h2', { class: 'section-title', text: title });
}

export function emptyState(text) {
  return el('p', { class: 'empty', text });
}

// ---------------------------------------------------------------- reload holds

const holds = new Set();

export function holdReload(key) {
  holds.add(key);
  notifyHolds();
  return key;
}

export function releaseReload(key) {
  if (holds.delete(key)) notifyHolds();
}

export function reloadHeld() {
  return holds.size > 0;
}

function notifyHolds() {
  window.dispatchEvent(new CustomEvent('jakesdata:holds', { detail: { held: holds.size > 0, keys: [...holds] } }));
}

// ---------------------------------------------------------------- misc

// localStorage JSON, never throws.
export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch { /* private mode / quota */ }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch { /* ignore */ }
  },
};

// Trailing debounce; the returned function has .flush() (run now if pending) and .cancel().
export function debounce(fn, ms) {
  let timer = 0;
  let lastArgs = null;
  const debounced = (...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      const a = lastArgs;
      lastArgs = null;
      fn(...a);
    }, ms);
  };
  debounced.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
    const a = lastArgs || [];
    lastArgs = null;
    fn(...a);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = 0;
    lastArgs = null;
  };
  return debounced;
}

// Escapes, then ```blocks```, `code`, **bold**, headings, "- " / "1. " lists and paragraphs
// (single newlines inside a paragraph become <br>). Returns an HTML string.
// Placeholders for the lifted blocks use C0 control characters, so those (except tab /
// newline) are stripped from the input first: they never belong in text and would
// otherwise collide with the markers.
export function renderMarkdownLite(text) {
  const src = String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const blocks = [];
  const withBlocks = src.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre class="md-pre"><code${lang ? ` data-lang="${esc(lang)}"` : ''}>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (s) => {
    const codes = [];
    let out = esc(s).replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(`<code>${c}</code>`);
      return `\u0001${codes.length - 1}\u0001`;
    });
    out = out.replace(/\*\*([^*\n][^*]*?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\u0001(\d+)\u0001/g, (m, i) => (codes[Number(i)] === undefined ? m : codes[Number(i)]));
    return out;
  };
  const html = [];
  for (const chunk of withBlocks.split(/\n{2,}/)) {
    const part = chunk.trim();
    if (!part) continue;
    const lines = part.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      html.push(`<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`);
    } else if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      html.push(`<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`);
    } else if (/^\u0000\d+\u0000$/.test(part)) {
      html.push(part);
    } else if (lines.length === 1 && /^#{1,6}\s+/.test(part)) {
      html.push(`<p class="md-h">${inline(part.replace(/^#{1,6}\s+/, ''))}</p>`);
    } else {
      html.push(`<p>${lines.map(inline).join('<br>')}</p>`);
    }
  }
  return html.join('').replace(/\u0000(\d+)\u0000/g, (m, i) => (blocks[Number(i)] === undefined ? m : blocks[Number(i)]));
}
