// Notes app: a list (pinned first, then by last edit) with server-side search, and an editor
// (title + auto-growing body) that autosaves 600 ms after the last keystroke and only when
// something actually changed. Sub-routes: '' = list, '<id>' = editor, 'new' = create + edit.
// Data: /api/notes (server/apps/notes.js).
//
// Lifecycle notes:
//   - `+` builds the editor synchronously inside the tap (so iOS opens the keyboard), then
//     POSTs the empty note and swaps the hash from #/notes/new to #/notes/<id> in place.
//   - Leaving an editor whose title and body are both blank deletes the note again, so
//     backing out of `+` leaves no "Untitled" husks behind.
//   - holdReload: 'notes:editing' while a field has focus, 'notes:search' while the search
//     field has text and focus, 'notes:saving' while a change is unsaved or a save is in
//     flight (that one outlives unmount() until the final save settles, bounded by its timeout).
import * as kit from '../../kit.js';

const {
  api, el, toast, haptic, navbar, navButton, section, emptyState, holdReload, releaseReload,
  confirmSheet, debounce, fmt,
} = kit;

const SAVE_DEBOUNCE_MS = 600;
const SEARCH_DEBOUNCE_MS = 250;
const RETRY_MS = 4_000;
const TICK_MS = 5_000;
const SAVE_TIMEOUT_MS = 15_000;
const PREVIEW_MAX = 140;
const EDIT_HOLD = 'notes:editing';
const SEARCH_HOLD = 'notes:search';
const SAVE_HOLD = 'notes:saving';

let root = null;
let ctx = null;
let state = null;     // { notes, q, loaded, loadSeq, loadError, listScroll, listSeen, cache: Map<id, note> }
let view = null;      // { kind: 'list', ... } | { kind: 'editor', ... }
let listeners = [];

export default {
  mount(rootEl, context) {
    root = rootEl;
    ctx = context;
    state = { notes: [], q: '', loaded: false, loadSeq: 0, loadError: null, listScroll: 0, listSeen: false, cache: new Map() };

    listen(window, 'jakesdata:online', onBackOnline);
    listen(window, 'jakesdata:foreground', onForeground);
    listen(document, 'visibilitychange', () => {
      if (document.hidden) onBackground();
      else onForeground();
    });
    listen(window, 'pagehide', onBackground);
    listen(window, 'resize', () => {
      if (view && view.kind === 'editor') autoGrow(view.els.body);
    });

    show(context.sub);
  },

  route(sub) {
    if (state) show(sub);
  },

  unmount() {
    leaveView();
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners = [];
    releaseReload(EDIT_HOLD);
    releaseReload(SEARCH_HOLD);
    state = null;
    view = null;
    ctx = null;
    root = null;
  },
};

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  listeners.push([target, type, fn]);
}

// The scrolling container is the launcher's #app layer (root's parent).
function layer() {
  return root && root.parentElement ? root.parentElement : null;
}

function show(sub) {
  const s = String(sub == null ? '' : sub).replace(/^\/+|\/+$/g, '');
  if (s === '') return showList();
  if (s === 'new') {
    if (view && view.kind === 'editor' && view.pending) return; // `+` already built it
    return showEditor(null);
  }
  if (/^\d{1,15}$/.test(s)) {
    const id = Number(s);
    if (view && view.kind === 'editor' && view.id === id) return;
    return showEditor(id);
  }
  toast('No such note');
  ctx.nav.replace('#/notes');
}

// ---------------------------------------------------------------- shared helpers

function isBlank(text) {
  return !String(text || '').trim();
}

// First non-empty line of a body, trimmed and capped (the same rule the server uses).
function previewOf(body) {
  for (const line of String(body || '').split('\n')) {
    const t = line.trim();
    if (t) return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX - 1)}…` : t;
  }
  return '';
}

// Pinned first, then last edited first (the server's order).
function sortNotes(list) {
  return list.slice().sort((a, b) =>
    (Number(b.pinned) - Number(a.pinned)) ||
    (Date.parse(b.updated_at) - Date.parse(a.updated_at)) ||
    (b.id - a.id));
}

// Keep the cached list in step with a note the editor just saved / pinned / created, so the
// list is right the instant it is shown again (it also refetches).
function syncListItem(note) {
  if (!state) return;
  state.cache.set(note.id, note);
  const item = { id: note.id, title: note.title, preview: previewOf(note.body), pinned: note.pinned, created_at: note.created_at, updated_at: note.updated_at };
  const i = state.notes.findIndex((n) => n.id === note.id);
  if (i >= 0) state.notes[i] = item;
  else if (!state.q.trim()) state.notes.push(item);
  state.notes = sortNotes(state.notes);
  if (view && view.kind === 'list') renderList();
}

function dropListItem(id) {
  if (!state) return;
  state.cache.delete(id);
  state.notes = state.notes.filter((n) => n.id !== id);
  if (view && view.kind === 'list') renderList();
}

// "just now", "12s ago", "3m ago", "2h ago", "4d ago", then a date.
function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return fmt.date(t);
}

function failureMessage(verb, err) {
  if (err && err.status) return `Couldn't ${verb}: ${err.message}`;
  return `Couldn't ${verb} — the PC is unreachable`;
}

function deleteQuietly(id) {
  api(`/api/notes/${id}`, { method: 'DELETE' }).catch(() => {});
}

function onBackOnline() {
  if (!view) return;
  if (view.kind === 'list') loadList();
  else if (view.error) flushSave(view);
  else if (!view.note && !view.pending) loadNote(view);
  else refreshNoteIfClean(view);
}

function onForeground() {
  if (!view) return;
  if (view.kind === 'list') loadList();
  else refreshNoteIfClean(view);
}

// The iOS shell may be suspended right after this: get any pending change on the wire now.
function onBackground() {
  if (view && view.kind === 'editor') view.scheduleSave.flush();
}

// ---------------------------------------------------------------- list

function showList() {
  leaveView();
  state.listSeen = true;

  const search = el('input', {
    class: 'notes-search', type: 'search', placeholder: 'Search', 'aria-label': 'Search notes',
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', enterkeyhint: 'search', value: state.q,
  });
  const lists = el('div', { class: 'note-lists' });
  const content = el('div', { class: 'app-content' }, el('div', { class: 'notes-search-wrap' }, search), lists);
  const nav = navbar({ title: 'Notes', right: [navButton({ icon: 'plus', label: 'New note', onClick: onNew })] });
  root.replaceChildren(nav, content);

  const v = { kind: 'list', els: { search, lists } };
  v.searchDebounce = debounce(loadList, SEARCH_DEBOUNCE_MS);
  view = v;

  const syncSearchHold = () => {
    if (document.activeElement === search && search.value.trim()) holdReload(SEARCH_HOLD);
    else releaseReload(SEARCH_HOLD);
  };
  search.addEventListener('input', () => {
    state.q = search.value;
    syncSearchHold();
    v.searchDebounce();
  });
  search.addEventListener('focus', syncSearchHold);
  search.addEventListener('blur', syncSearchHold);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      v.searchDebounce.flush();
      search.blur();
    }
  });

  renderList();
  const scroller = layer();
  if (scroller) scroller.scrollTop = state.listScroll;
  loadList();
}

async function loadList() {
  if (!state) return;
  const q = state.q.trim();
  const seq = ++state.loadSeq;
  try {
    const data = await api(`/api/notes${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (!state || seq !== state.loadSeq) return;
    state.notes = sortNotes(Array.isArray(data.notes) ? data.notes : []);
    state.loaded = true;
    state.loadError = null;
  } catch (err) {
    if (!state || seq !== state.loadSeq) return;
    state.loadError = err;
  }
  renderList();
}

function renderList() {
  if (!state || !view || view.kind !== 'list') return;
  const q = state.q.trim();
  const pinned = state.notes.filter((n) => n.pinned);
  const rest = state.notes.filter((n) => !n.pinned);
  const parts = [];
  if (pinned.length) parts.push(section('Pinned'), noteCard(pinned));
  if (rest.length) parts.push(pinned.length ? section('Notes') : null, noteCard(rest));
  if (!state.notes.length) {
    if (state.loaded) parts.push(emptyState(q ? 'No notes match.' : 'No notes yet. Tap + to write one.'));
    else if (state.loadError) parts.push(emptyState("Couldn't load notes — the PC is unreachable."));
  }
  view.els.lists.replaceChildren(...parts.filter(Boolean));
}

function noteCard(notes) {
  return el('ul', { class: 'card note-list' }, notes.map(noteRow));
}

function noteRow(note) {
  return el('li', { class: 'note-row', dataset: { id: note.id } },
    el('button', { class: 'note-btn', type: 'button', 'on:click': () => openNote(note.id) },
      el('div', { class: `note-row-title${note.title ? '' : ' untitled'}`, text: note.title || 'Untitled' }),
      el('div', { class: 'note-row-sub' },
        el('span', { class: 'note-row-time', text: fmt.relTime(note.updated_at) }),
        el('span', { class: `note-row-preview${note.preview ? '' : ' none'}`, text: note.preview || 'No additional text' }))));
}

function openNote(id) {
  haptic('light');
  ctx.nav.go(`#/notes/${id}`);
}

// Build the editor inside the tap itself so the title field gets focus from a user gesture
// (iOS only raises the keyboard for that), then route to #/notes/new so history is right.
function onNew() {
  haptic('light');
  showEditor(null);
  ctx.nav.go('#/notes/new');
}

// ---------------------------------------------------------------- editor

function showEditor(id) {
  leaveView();
  const scroller = layer();
  if (scroller) scroller.scrollTop = 0;

  const v = {
    kind: 'editor',
    id,
    pending: id === null,   // created by `+`: no id until the POST answers
    note: null,             // the server's copy (null until loaded / created)
    saved: null,            // { title, body } as last sent to the server
    inflight: false,
    again: false,           // typed during an in-flight save: run once more after it
    error: false,
    deleted: false,
    leftWith: null,         // values at the moment a pending editor was left
    retryTimer: 0,
    tickTimer: 0,
    els: null,
  };

  const title = el('input', {
    class: 'note-title-input', type: 'text', placeholder: 'Title', 'aria-label': 'Title', maxlength: '500',
    autocomplete: 'off', autocapitalize: 'sentences', enterkeyhint: 'next', readonly: id !== null,
  });
  const body = el('textarea', {
    class: 'note-body', placeholder: 'Note', 'aria-label': 'Note', rows: '1', autocapitalize: 'sentences', readonly: id !== null,
  });
  const status = el('p', { class: 'note-status', 'aria-live': 'polite' });
  const tail = el('div', { class: 'note-tail', 'aria-hidden': 'true' });
  const content = el('div', { class: 'app-content note-editor' }, status, title, body, tail);
  const pinBtn = navButton({ icon: 'pin', label: 'Pin', onClick: () => togglePin(v) });
  pinBtn.setAttribute('aria-pressed', 'false');
  pinBtn.disabled = true;
  const delBtn = navButton({ icon: 'trash', label: 'Delete', onClick: () => deleteNote(v) });
  delBtn.disabled = true;
  const nav = navbar({ title: '', back: true, right: [pinBtn, delBtn], onBack: () => goBackToList() });
  root.replaceChildren(nav, content);
  v.els = { title, body, status, pinBtn, delBtn };
  v.scheduleSave = debounce(() => flushSave(v), SAVE_DEBOUNCE_MS);
  view = v;

  const onInput = () => {
    if (!v.note && !v.pending) return;
    holdReload(SAVE_HOLD);
    v.scheduleSave();
  };
  for (const field of [title, body]) {
    field.addEventListener('input', onInput);
    field.addEventListener('focus', () => holdReload(EDIT_HOLD));
    field.addEventListener('blur', () => {
      // Moving between the two fields blurs one before focusing the other.
      setTimeout(() => {
        if (document.activeElement !== title && document.activeElement !== body) releaseReload(EDIT_HOLD);
      }, 0);
    });
  }
  body.addEventListener('input', () => autoGrow(body));
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      body.focus();
      body.setSelectionRange(0, 0);
    }
  });
  // A tap on the blank space under the text keeps writing at the end of the note.
  tail.addEventListener('click', () => {
    if (body.readOnly) return;
    body.focus();
    const end = body.value.length;
    body.setSelectionRange(end, end);
  });

  v.tickTimer = setInterval(() => {
    if (view === v && v.note && !v.inflight && !v.error && !diff(v)) setStatus(v, savedText(v));
  }, TICK_MS);

  if (id === null) {
    setStatus(v, 'New note');
    title.focus();
    createNote(v);
  } else {
    const cached = state.cache.get(id);
    if (cached) applyNote(v, cached);
    else setStatus(v, 'Loading…');
    loadNote(v);
  }
}

function setStatus(v, text) {
  if (v.els) v.els.status.textContent = text;
}

function savedText(v) {
  return v.note ? `Saved · ${ago(v.note.updated_at)}` : '';
}

function autoGrow(ta) {
  const scroller = layer();
  const top = scroller ? scroller.scrollTop : 0;
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
  if (scroller) scroller.scrollTop = top;
}

// Puts the server's copy into the editor (only when it differs from what is on screen, so
// the caret is left alone otherwise) and resets the "last saved" snapshot.
function applyNote(v, note) {
  const { title, body, pinBtn, delBtn } = v.els;
  v.note = note;
  v.saved = { title: note.title, body: note.body };
  if (title.value !== note.title) title.value = note.title;
  if (body.value !== note.body) body.value = note.body;
  title.readOnly = false;
  body.readOnly = false;
  pinBtn.disabled = false;
  delBtn.disabled = false;
  setPinButton(v, note.pinned);
  autoGrow(body);
  state.cache.set(note.id, note);
  setStatus(v, savedText(v));
}

function setPinButton(v, pinned) {
  v.els.pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  v.els.pinBtn.setAttribute('aria-label', pinned ? 'Unpin' : 'Pin');
}

async function loadNote(v) {
  const id = v.id;
  try {
    const data = await api(`/api/notes/${id}`);
    if (!state || v.deleted) return;
    if (v.note && diff(v)) return; // typed since (cached open): never clobber unsaved text
    applyNote(v, data.note);
  } catch (err) {
    if (!state || view !== v) return;
    if (err && err.status === 404) {
      toast('That note is gone');
      dropListItem(id);
      ctx.nav.replace('#/notes');
    } else if (err && err.status) {
      toast(failureMessage('open the note', err), { kind: 'error' });
      ctx.nav.replace('#/notes');
    } else if (!v.note) {
      setStatus(v, "Couldn't load — the PC is unreachable");
    }
  }
}

// Foreground / back online with nothing unsaved: pick up edits made elsewhere (the desktop).
function refreshNoteIfClean(v) {
  if (v.kind !== 'editor' || v.pending || !v.note || v.inflight || diff(v)) return;
  loadNote(v);
}

async function createNote(v) {
  let note;
  try {
    note = (await api('/api/notes', { method: 'POST', body: {} })).note;
  } catch (err) {
    if (view !== v || !state) return;
    toast(failureMessage('create the note', err), { kind: 'error' });
    ctx.nav.replace('#/notes');
    return;
  }
  v.id = note.id;
  v.pending = false;
  v.note = note;
  v.saved = { title: note.title, body: note.body };
  if (view !== v || !state) {
    // Left before the POST answered: keep what was typed, or drop the empty husk.
    const left = v.leftWith || { title: '', body: '' };
    if (isBlank(left.title) && isBlank(left.body)) deleteQuietly(note.id);
    else api(`/api/notes/${note.id}`, { method: 'PATCH', body: left, timeout: SAVE_TIMEOUT_MS }).then((data) => syncListItem(data.note)).catch(() => {});
    return;
  }
  state.cache.set(note.id, note);
  syncListItem(note);
  v.els.pinBtn.disabled = false;
  v.els.delBtn.disabled = false;
  setStatus(v, savedText(v));
  ctx.nav.replace(`#/notes/${note.id}`);
  if (diff(v)) flushSave(v); // typed while the POST was in flight
}

// The fields that differ from the last snapshot sent to the server, or null.
function diff(v) {
  if (!v.saved || !v.els) return null;
  const patch = {};
  if (v.els.title.value !== v.saved.title) patch.title = v.els.title.value;
  if (v.els.body.value !== v.saved.body) patch.body = v.els.body.value;
  return Object.keys(patch).length ? patch : null;
}

// Sends what changed since the last save. Runs on the editor object, not the screen, so a
// save started just before leaving the editor still completes. One request at a time; a
// change made while one is in flight queues exactly one more.
async function flushSave(v) {
  if (v.deleted || v.pending || !v.note) return;
  if (v.inflight) {
    v.again = true;
    return;
  }
  const patch = diff(v);
  if (!patch) {
    releaseReload(SAVE_HOLD);
    return;
  }
  clearTimeout(v.retryTimer);
  v.inflight = true;
  v.error = false;
  holdReload(SAVE_HOLD);
  if (view === v) setStatus(v, 'Saving…');
  const id = v.id;
  try {
    const data = await api(`/api/notes/${id}`, { method: 'PATCH', body: patch, timeout: SAVE_TIMEOUT_MS });
    v.saved = { ...v.saved, ...patch };
    v.note = data.note;
    syncListItem(data.note);
    if (view === v) setStatus(v, savedText(v));
  } catch (err) {
    if (err && err.status === 404) {
      v.deleted = true;
      dropListItem(id);
      if (view === v) {
        toast('That note is gone');
        ctx.nav.replace('#/notes');
      }
    } else if (err && err.status === 400) {
      // Too long etc.: no point retrying the same text; the next keystroke tries again.
      v.error = true;
      if (view === v) setStatus(v, `Couldn't save: ${err.message}`);
    } else {
      v.error = true;
      if (view === v) setStatus(v, "Couldn't save · retrying");
      v.retryTimer = setTimeout(() => flushSave(v), RETRY_MS);
    }
  } finally {
    v.inflight = false;
    if (v.again) {
      v.again = false;
      flushSave(v);
    } else if (!diff(v) || v.deleted) {
      releaseReload(SAVE_HOLD);
    }
  }
}

async function togglePin(v) {
  if (!v.note || v.deleted) return;
  const next = !v.note.pinned;
  haptic('light');
  v.note = { ...v.note, pinned: next };
  setPinButton(v, next);
  try {
    const data = await api(`/api/notes/${v.id}`, { method: 'PATCH', body: { pinned: next } });
    if (v.deleted) return;
    // Only the pin state and timestamps come from this answer: title/body on screen may be
    // newer than what the server has.
    v.note = { ...v.note, pinned: data.note.pinned, updated_at: data.note.updated_at };
    syncListItem({ ...data.note, title: v.note.title, body: v.note.body });
  } catch (err) {
    if (v.deleted) return;
    v.note = { ...v.note, pinned: !next };
    if (view === v) setPinButton(v, !next);
    if (err && err.status === 404) {
      v.deleted = true;
      dropListItem(v.id);
      if (view === v) {
        toast('That note is gone');
        ctx.nav.replace('#/notes');
      }
      return;
    }
    toast(failureMessage(next ? 'pin' : 'unpin', err), { kind: 'error' });
    haptic('error');
  }
}

async function deleteNote(v) {
  if (!v.note || v.deleted) return;
  const ok = await confirmSheet({
    title: 'Delete this note?',
    message: "This can't be undone.",
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!ok || view !== v || v.deleted) return;
  v.scheduleSave.cancel();
  v.deleted = true;
  v.els.delBtn.disabled = true;
  try {
    await api(`/api/notes/${v.id}`, { method: 'DELETE' });
  } catch (err) {
    if (!(err && err.status === 404)) {
      v.deleted = false;
      if (view === v) v.els.delBtn.disabled = false;
      toast(failureMessage('delete', err), { kind: 'error' });
      haptic('error');
      return;
    }
  }
  releaseReload(SAVE_HOLD);
  dropListItem(v.id);
  haptic('success');
  if (view === v) goBackToList();
}

// ‹ Back: the list we came from when it is the previous history entry, else push the list
// (a deep link from the Graph must not bounce to the home screen).
function goBackToList() {
  if (state && state.listSeen) ctx.nav.back();
  else ctx.nav.go('#/notes');
}

// ---------------------------------------------------------------- leaving a view

function leaveView() {
  if (!view) return;
  const v = view;
  view = null;
  if (v.kind === 'list') {
    const scroller = layer();
    if (scroller && state) state.listScroll = scroller.scrollTop;
    v.searchDebounce.cancel();
    releaseReload(SEARCH_HOLD);
    return;
  }
  clearInterval(v.tickTimer);
  clearTimeout(v.retryTimer);
  v.scheduleSave.cancel();
  releaseReload(EDIT_HOLD);
  const title = v.els.title.value;
  const body = v.els.body.value;
  if (v.deleted) {
    releaseReload(SAVE_HOLD);
    return;
  }
  if (v.pending) {
    v.leftWith = { title, body }; // createNote() finishes the job when the POST answers
    return;
  }
  if (!v.note) {
    releaseReload(SAVE_HOLD); // never loaded: nothing of ours to save
    return;
  }
  if (isBlank(title) && isBlank(body)) {
    // An empty note is a husk (usually `+` then back): remove it instead of saving it.
    v.deleted = true;
    deleteQuietly(v.id);
    dropListItem(v.id);
    releaseReload(SAVE_HOLD);
    return;
  }
  flushSave(v); // sends now if anything changed; releases the hold itself when settled
}
