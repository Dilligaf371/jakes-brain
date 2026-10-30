// HQ web app. Plain ES module, no build step. Every API call is relative (/api/...):
// the page is always served by the same server, so there is no base URL to configure.

const POLL_MS = 30_000;          // /api/version + Home status refresh
const BACKOFF_START_MS = 2_000;  // unreachable retry: 2s, 4s, 8s, ... max 30s
const BACKOFF_MAX_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;  // a PC that is asleep / off the tailnet blackholes SYNs for ~60 s otherwise
const TOAST_MS = 2_600;
const ARM_MS = 3_000;            // how long the "Delete" confirm stays armed
const UI_KEY = 'hq.ui';          // sessionStorage: tab + unsent note draft across a reload
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);

const els = {
  banner: $('banner'),
  toast: $('toast'),
  views: { home: $('view-home'), notes: $('view-notes'), about: $('view-about') },
  tabs: Array.from(document.querySelectorAll('.tab[data-tab]')),
  machine: {
    host: $('machine-host'),
    uptime: $('machine-uptime'),
    load: $('machine-load'),
    mem: $('machine-mem'),
    disk: $('machine-disk'),
    diskBar: $('machine-disk-bar'),
  },
  services: $('services'),
  updated: $('status-updated'),
  noteForm: $('note-form'),
  noteInput: $('note-input'),
  noteAdd: $('note-add'),
  notesOpen: $('notes-open'),
  notesDone: $('notes-done'),
  notesDoneTitle: $('notes-done-title'),
  notesEmpty: $('notes-empty'),
  about: {
    base: $('about-base'),
    build: $('about-build'),
    started: $('about-started'),
    shell: $('about-shell'),
    reload: $('about-reload'),
  },
};

const state = {
  tab: 'home',
  status: null,
  statusAt: 0,
  notes: [],
  notesLoaded: false,
  version: null,
  loadedBuild: null, // build reported by the first successful /api/version after load
};

// ---------------------------------------------------------------- native bridge

// window.HQ = { native: true, version: "1.0 (1)" } is injected by the iOS shell.
// On the Mac it is undefined, so everything here is feature-detected.
function shellVersion() {
  const hq = window.HQ;
  return hq && hq.version ? String(hq.version) : 'web';
}

function haptic(style) {
  try {
    const webkit = window.webkit;
    const handler = webkit && webkit.messageHandlers && webkit.messageHandlers.native;
    if (handler && typeof handler.postMessage === 'function') handler.postMessage({ type: 'haptic', style });
  } catch {
    /* not running inside the native shell */
  }
}

// ---------------------------------------------------------------- connectivity

const conn = { offline: false, delay: BACKOFF_START_MS, timer: 0 };

function markOffline() {
  if (!conn.offline) {
    conn.offline = true;
    els.banner.hidden = false;
    document.body.classList.add('offline');
    renderUpdated();
  }
  if (conn.timer) return;
  const wait = conn.delay;
  conn.delay = Math.min(conn.delay * 2, BACKOFF_MAX_MS);
  conn.timer = setTimeout(() => {
    conn.timer = 0;
    refreshAll();
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
  els.banner.hidden = true;
  document.body.classList.remove('offline');
  renderUpdated();
}

// ---------------------------------------------------------------- api

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const isAbort = (err) => Boolean(err) && err.name === 'AbortError';

// Every call is bounded by FETCH_TIMEOUT_MS. Without it a hung request (PC asleep, peer
// offline) held the inflight flags for the browser's ~60 s default, so tab switches and
// hq:foreground did nothing and the banner never showed.
async function api(path, { method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const init = { method, cache: 'no-store', headers: { Accept: 'application/json' }, signal: ctrl.signal };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    let res;
    try {
      res = await fetch(path, init);
    } catch (err) {
      markOffline();
      throw new ApiError(isAbort(err) ? 'timeout' : 'network', 0);
    }
    if (res.status === 204) {
      markOnline();
      return null;
    }
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      if (isAbort(err)) {
        markOffline();
        throw new ApiError('timeout', 0);
      }
      data = null;
    }
    markOnline();
    if (!res.ok) throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- formatting

function fmtUptime(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtGB(bytes, digits) {
  return Number.isFinite(bytes) ? (bytes / 1e9).toFixed(digits) : '—';
}

// "2d", "4h", "12m", "now"
function fmtRel(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

// ---------------------------------------------------------------- dom helpers

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function checkIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M5.5 12.5l4.2 4.2L18.5 7.8');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#ffffff');
  path.setAttribute('stroke-width', '2.4');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

let toastTimer = 0;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, TOAST_MS);
}

// ---------------------------------------------------------------- home

let statusInflight = false;
async function loadStatus() {
  if (statusInflight) return;
  statusInflight = true;
  try {
    state.status = await api('/api/status');
    state.statusAt = Date.now();
    renderStatus();
  } catch {
    renderUpdated();
  } finally {
    statusInflight = false;
  }
}

function renderStatus() {
  const s = state.status;
  if (!s) return;
  const m = els.machine;
  m.host.textContent = s.host || '—';
  m.uptime.textContent = fmtUptime(s.uptime_s);
  m.load.textContent = Array.isArray(s.load) ? s.load.map((n) => Number(n).toFixed(2)).join('  ') : '—';
  m.mem.textContent = s.mem ? `${fmtGB(s.mem.used, 1)} / ${fmtGB(s.mem.total, 1)} GB` : '—';
  if (s.disk && s.disk.total > 0) {
    m.disk.textContent = `${fmtGB(s.disk.used, 0)} / ${fmtGB(s.disk.total, 0)} GB`;
    const pct = Math.min(100, Math.max(0, (s.disk.used / s.disk.total) * 100));
    m.diskBar.style.width = `${pct.toFixed(1)}%`;
  } else {
    m.disk.textContent = '—';
    m.diskBar.style.width = '0%';
  }
  renderServices(Array.isArray(s.services) ? s.services : []);
  renderUpdated();
}

function renderServices(services) {
  const rows = services.map((svc) => {
    const active = svc.active || 'unknown';
    const right = svc.since ? fmtRel(svc.since) : active;
    return el('li', { class: 'row', title: svc.unit || null }, [
      el('span', { class: 'dot', 'data-state': active, 'aria-label': active }),
      el('span', { class: 'label' }, svc.label || svc.unit || '—'),
      el('span', { class: 'right' }, right),
    ]);
  });
  if (!rows.length) rows.push(el('li', { class: 'row' }, [el('span', { class: 'label muted' }, 'No services configured')]));
  els.services.replaceChildren(...rows);
}

function renderUpdated() {
  if (!state.statusAt) {
    els.updated.textContent = conn.offline ? 'No data yet' : ' ';
    return;
  }
  els.updated.textContent = `Updated ${fmtAgo(Date.now() - state.statusAt)} ago`;
}

// ---------------------------------------------------------------- notes

let notesInflight = false;
async function loadNotes() {
  if (notesInflight) return;
  notesInflight = true;
  try {
    const data = await api('/api/notes');
    state.notes = sortNotes(Array.isArray(data.notes) ? data.notes : []);
    state.notesLoaded = true;
    renderNotes();
  } catch {
    /* keep whatever is on screen; the banner reports the outage */
  } finally {
    notesInflight = false;
  }
}

// Open first (newest first), then done (newest first) -- same order as the server.
function sortNotes(list) {
  return list.slice().sort((a, b) =>
    (Number(a.done) - Number(b.done)) ||
    (Date.parse(b.created_at) - Date.parse(a.created_at)) ||
    (b.id - a.id));
}

function renderNotes() {
  const open = state.notes.filter((n) => !n.done);
  const done = state.notes.filter((n) => n.done);
  els.notesOpen.replaceChildren(...open.map(noteRow));
  els.notesDone.replaceChildren(...done.map(noteRow));
  els.notesOpen.hidden = open.length === 0;
  els.notesDone.hidden = done.length === 0;
  els.notesDoneTitle.hidden = done.length === 0;
  els.notesEmpty.hidden = !(state.notesLoaded && state.notes.length === 0);
}

function noteRow(note) {
  const check = el('button', {
    class: 'check',
    type: 'button',
    role: 'checkbox',
    'aria-checked': String(Boolean(note.done)),
    'aria-label': note.done ? 'Mark as not done' : 'Mark as done',
  }, [checkIcon()]);
  check.addEventListener('click', () => toggleNote(note.id));

  const del = el('button', { class: 'del', type: 'button', 'aria-label': 'Delete note' }, '×');
  del.addEventListener('click', () => armDelete(del, note.id));

  const li = el('li', { class: note.pending ? 'note pending' : 'note', 'data-id': note.id }, [
    check,
    el('span', { class: 'text' }, note.text),
    del,
  ]);
  return li;
}

// Quick confirm without window.confirm(): first tap turns the × into "Delete" for a few
// seconds, a second tap deletes.
function armDelete(button, id) {
  if (button.dataset.armed === 'true') {
    disarm(button);
    deleteNote(id);
    return;
  }
  button.dataset.armed = 'true';
  button.textContent = 'Delete';
  button.setAttribute('aria-label', 'Confirm delete');
  button.disarmTimer = setTimeout(() => disarm(button), ARM_MS);
}

function disarm(button) {
  clearTimeout(button.disarmTimer);
  button.dataset.armed = 'false';
  button.textContent = '×';
  button.setAttribute('aria-label', 'Delete note');
}

function patchLocal(id, patch) {
  state.notes = sortNotes(state.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)));
}

function failureMessage(verb, err) {
  if (err && err.status === 404) return `That note is gone (${verb} skipped)`;
  if (err && err.status) return `Couldn't ${verb}: ${err.message}`;
  return `Couldn't ${verb} — the PC is unreachable`;
}

async function addNote(text) {
  const tempId = -Date.now();
  const now = new Date().toISOString();
  state.notes = sortNotes([{ id: tempId, text, done: false, created_at: now, updated_at: now, pending: true }, ...state.notes]);
  state.notesLoaded = true;
  renderNotes();
  haptic('success');
  try {
    const data = await api('/api/notes', { method: 'POST', body: { text } });
    state.notes = sortNotes(state.notes.map((n) => (n.id === tempId ? data.note : n)));
    renderNotes();
  } catch (err) {
    state.notes = state.notes.filter((n) => n.id !== tempId);
    renderNotes();
    if (!els.noteInput.value) els.noteInput.value = text; // give the text back
    syncAdd(); // programmatic value changes fire no 'input' event
    toast(failureMessage('add', err));
    haptic('error');
  }
}

async function toggleNote(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note || note.pending) return;
  const next = !note.done;
  haptic('light');
  patchLocal(id, { done: next });
  renderNotes();
  try {
    const data = await api(`/api/notes/${id}`, { method: 'PATCH', body: { done: next } });
    state.notes = sortNotes(state.notes.map((n) => (n.id === id ? data.note : n)));
    renderNotes();
  } catch (err) {
    if (err && err.status === 404) {
      state.notes = state.notes.filter((n) => n.id !== id);
    } else {
      patchLocal(id, { done: !next });
    }
    renderNotes();
    toast(failureMessage('update', err));
    haptic('error');
  }
}

async function deleteNote(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note || note.pending) return;
  state.notes = state.notes.filter((n) => n.id !== id);
  renderNotes();
  try {
    await api(`/api/notes/${id}`, { method: 'DELETE' });
  } catch (err) {
    if (err && err.status === 404) return; // already gone: nothing to revert
    state.notes = sortNotes([...state.notes, note]);
    renderNotes();
    toast(failureMessage('delete', err));
    haptic('error');
  }
}

// The Add button's state is always derived from the input, never toggled by hand, so a
// failed add that hands the text back leaves Add (and Enter) usable.
function syncAdd() {
  els.noteAdd.disabled = els.noteInput.value.trim().length === 0;
}

els.noteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.noteInput.value.trim();
  if (!text) return;
  els.noteInput.value = '';
  syncAdd();
  addNote(text);
});

els.noteInput.addEventListener('input', syncAdd);

// ---------------------------------------------------------------- about + live update

function renderAbout() {
  els.about.base.textContent = location.origin;
  els.about.shell.textContent = shellVersion();
  const v = state.version;
  els.about.build.textContent = v && v.build ? v.build : '—';
  els.about.started.textContent = v && v.started ? fmtDateTime(v.started) : '—';
}

// A reload keeps the user's place: current tab + any unsent note text come back after it.
function persistUi() {
  try {
    sessionStorage.setItem(UI_KEY, JSON.stringify({ tab: state.tab, draft: els.noteInput.value }));
  } catch {
    /* storage unavailable: start on Home like a fresh launch */
  }
}

function restoreUi() {
  try {
    const raw = sessionStorage.getItem(UI_KEY);
    sessionStorage.removeItem(UI_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    return saved && typeof saved === 'object' ? saved : null;
  } catch {
    return null;
  }
}

function reloadPage() {
  persistUi();
  location.reload();
}

const typingNote = () => document.activeElement === els.noteInput && els.noteInput.value.trim().length > 0;

els.about.reload.addEventListener('click', reloadPage);

let versionInflight = false;
async function pollVersion() {
  if (versionInflight) return;
  versionInflight = true;
  try {
    const v = await api('/api/version');
    state.version = v;
    renderAbout();
    if (state.loadedBuild === null) {
      state.loadedBuild = v.build;
    } else if (v.build !== state.loadedBuild) {
      // Never yank the keyboard away mid-sentence; the build is still different on the
      // next poll, so the reload simply happens then.
      if (!typingNote()) reloadPage();
    }
  } catch {
    /* banner + backoff handle it */
  } finally {
    versionInflight = false;
  }
}

// ---------------------------------------------------------------- tabs + scheduling

function setTab(tab) {
  if (!els.views[tab]) tab = 'home';
  state.tab = tab;
  for (const [name, view] of Object.entries(els.views)) view.hidden = name !== tab;
  for (const button of els.tabs) {
    if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  refreshView();
}

function refreshView() {
  if (state.tab === 'home') loadStatus();
  else if (state.tab === 'notes') loadNotes();
  else renderAbout();
}

function refreshAll() {
  pollVersion();
  refreshView();
}

for (const button of els.tabs) button.addEventListener('click', () => setTab(button.dataset.tab));

setInterval(() => {
  if (document.hidden) return;
  pollVersion();
  if (state.tab === 'home') loadStatus();
}, POLL_MS);

setInterval(() => {
  if (!document.hidden && state.tab === 'home') renderUpdated();
}, 1000);

window.addEventListener('hq:foreground', refreshAll);
window.addEventListener('online', refreshAll);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshAll();
});

// ---------------------------------------------------------------- boot

const saved = restoreUi();
if (saved && typeof saved.draft === 'string' && saved.draft && !els.noteInput.value) els.noteInput.value = saved.draft;
syncAdd();
renderAbout();
setTab(saved && typeof saved.tab === 'string' ? saved.tab : 'home');
pollVersion();
