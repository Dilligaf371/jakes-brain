// Capture app: a frictionless inbox. Input + Add at top, Inbox (unprocessed) / Done sections,
// optimistic add, a check toggles `processed`, two-tap delete (× turns into "Delete" for 3 s).
// Data: /api/capture.
import * as kit from '../../kit.js';

const { api, el, toast, haptic, navbar, section, emptyState, holdReload, releaseReload, store, icon } = kit;

const ARM_MS = 3_000;              // how long the "Delete" confirm stays armed
const DRAFT_KEY = 'capture.draft'; // unsent text survives a reload
const HOLD_KEY = 'capture:typing';

let state = null;
let els = null;
let listeners = [];

export default {
  mount(root) {
    state = { items: [], loaded: false, inflight: false };

    const input = el('input', {
      class: 'input capture-input', type: 'text', name: 'text', placeholder: 'Capture a thought', maxlength: '4000',
      autocapitalize: 'sentences', autocorrect: 'on', enterkeyhint: 'done', 'aria-label': 'Capture a thought', autocomplete: 'off',
    });
    const add = el('button', { class: 'capture-add', type: 'submit', text: 'Add' });
    const form = el('form', { class: 'capture-form', autocomplete: 'off' }, input, add);
    const open = el('ul', { class: 'card list captures', 'aria-label': 'Inbox' });
    const empty = emptyState('Inbox zero.');
    empty.hidden = true;
    const doneTitle = section('Done');
    doneTitle.hidden = true;
    const done = el('ul', { class: 'card list captures captures-done', 'aria-label': 'Processed' });
    done.hidden = true;

    root.append(navbar({ title: 'Capture' }), el('div', { class: 'app-content' }, form, open, empty, doneTitle, done));
    els = { input, add, form, open, empty, doneTitle, done };

    const draft = store.get(DRAFT_KEY, '');
    if (typeof draft === 'string' && draft) input.value = draft;
    syncAdd();

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      store.del(DRAFT_KEY);
      syncAdd();
      syncHold(); // empty again: let a pending build-change reload through
      addCapture(text);
    });
    input.addEventListener('input', () => {
      syncAdd();
      store.set(DRAFT_KEY, input.value);
      syncHold();
    });
    input.addEventListener('focus', syncHold);
    input.addEventListener('blur', () => releaseReload(HOLD_KEY));

    load();
    listen(window, 'jakesdata:online', load);
    listen(window, 'jakesdata:foreground', load);
    listen(document, 'visibilitychange', () => { if (!document.hidden) load(); });
  },

  unmount() {
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners = [];
    releaseReload(HOLD_KEY);
    state = null;
    els = null;
  },
};

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  listeners.push([target, type, fn]);
}

// Never yank the keyboard away mid-sentence: hold the build-change reload while typing.
function syncHold() {
  if (!els) return;
  if (document.activeElement === els.input && els.input.value.trim()) holdReload(HOLD_KEY);
  else releaseReload(HOLD_KEY);
}

// The Add button's state is always derived from the input, never toggled by hand, so a
// failed add that hands the text back leaves Add (and Enter) usable.
function syncAdd() {
  if (els) els.add.disabled = els.input.value.trim().length === 0;
}

async function load() {
  if (!state || state.inflight) return;
  state.inflight = true;
  try {
    const data = await api('/api/capture');
    if (!state) return;
    state.items = sortItems(Array.isArray(data.items) ? data.items : []);
    state.loaded = true;
    render();
  } catch {
    /* keep whatever is on screen; the banner reports the outage */
  } finally {
    if (state) state.inflight = false;
  }
}

// Unprocessed first (newest first), then processed (newest first) -- same order as the server.
function sortItems(list) {
  return list.slice().sort((a, b) =>
    (Number(a.processed) - Number(b.processed)) ||
    (Date.parse(b.created_at) - Date.parse(a.created_at)) ||
    (b.id - a.id));
}

function render() {
  if (!state || !els) return;
  const open = state.items.filter((t) => !t.processed);
  const done = state.items.filter((t) => t.processed);
  els.open.replaceChildren(...open.map(captureRow));
  els.done.replaceChildren(...done.map(captureRow));
  els.open.hidden = open.length === 0;
  els.done.hidden = done.length === 0;
  els.doneTitle.hidden = done.length === 0;
  els.empty.hidden = !(state.loaded && state.items.length === 0);
}

function captureRow(item) {
  const check = el('button', {
    class: 'check',
    type: 'button',
    role: 'checkbox',
    'aria-checked': String(Boolean(item.processed)),
    'aria-label': item.processed ? 'Mark as unprocessed' : 'Mark as processed',
    'on:click': () => toggleProcessed(item.id),
  }, icon('check', { size: 14, strokeWidth: 2.6 }));
  const del = el('button', { class: 'del', type: 'button', 'aria-label': 'Delete capture', text: '×' });
  del.addEventListener('click', () => armDelete(del, item.id));
  const body = el('div', { class: 'body' }, el('span', { class: 'text', text: item.text }), chips(item));
  return el('li', { class: item.pending ? 'capture pending' : 'capture', dataset: { id: item.id } },
    check, body, del);
}

// Small chips for kind / source when present; false (skipped by el) when neither is set.
function chips(item) {
  const tags = [item.kind, item.source].filter((t) => typeof t === 'string' && t.trim());
  if (!tags.length) return false;
  return el('span', { class: 'chips' }, ...tags.map((t) => el('span', { class: 'chip', text: t })));
}

// Quick confirm without a dialog: first tap turns the × into "Delete" for a few seconds, a
// second tap deletes.
function armDelete(button, id) {
  if (button.dataset.armed === 'true') {
    disarm(button);
    deleteCapture(id);
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
  button.setAttribute('aria-label', 'Delete capture');
}

function patchLocal(id, patch) {
  state.items = sortItems(state.items.map((t) => (t.id === id ? { ...t, ...patch } : t)));
}

function failureMessage(verb, err) {
  if (err && err.status === 404) return `That capture is gone (${verb} skipped)`;
  if (err && err.status) return `Couldn't ${verb}: ${err.message}`;
  return `Couldn't ${verb} — the PC is unreachable`;
}

async function addCapture(text) {
  if (!state) return;
  const tempId = -Date.now();
  const now = new Date().toISOString();
  state.items = sortItems([{ id: tempId, text, kind: null, source: null, processed: false, created_at: now, updated_at: now, pending: true }, ...state.items]);
  state.loaded = true;
  render();
  haptic('success');
  try {
    const data = await api('/api/capture', { method: 'POST', body: { text } });
    if (!state) return;
    state.items = sortItems(state.items.map((t) => (t.id === tempId ? data.item : t)));
    render();
  } catch (err) {
    if (!state) return;
    state.items = state.items.filter((t) => t.id !== tempId);
    render();
    if (!els.input.value) {
      els.input.value = text; // give the text back
      store.set(DRAFT_KEY, text);
    }
    syncAdd(); // programmatic value changes fire no 'input' event
    toast(failureMessage('add', err), { kind: 'error' });
    haptic('error');
  }
}

async function toggleProcessed(id) {
  if (!state) return;
  const item = state.items.find((t) => t.id === id);
  if (!item || item.pending) return;
  const next = !item.processed;
  haptic('light');
  patchLocal(id, { processed: next });
  render();
  try {
    const data = await api(`/api/capture/${id}`, { method: 'PATCH', body: { processed: next } });
    if (!state) return;
    state.items = sortItems(state.items.map((t) => (t.id === id ? data.item : t)));
    render();
  } catch (err) {
    if (!state) return;
    if (err && err.status === 404) state.items = state.items.filter((t) => t.id !== id);
    else patchLocal(id, { processed: !next });
    render();
    toast(failureMessage('update', err), { kind: 'error' });
    haptic('error');
  }
}

async function deleteCapture(id) {
  if (!state) return;
  const item = state.items.find((t) => t.id === id);
  if (!item || item.pending) return;
  state.items = state.items.filter((t) => t.id !== id);
  render();
  try {
    await api(`/api/capture/${id}`, { method: 'DELETE' });
  } catch (err) {
    if (!state) return;
    if (err && err.status === 404) return; // already gone: nothing to revert
    state.items = sortItems([...state.items, item]);
    render();
    toast(failureMessage('delete', err), { kind: 'error' });
    haptic('error');
  }
}
