// Tasks app: the v1 Notes checklist, behaviour unchanged. Input + Add, Open / Done sections,
// optimistic updates, two-tap delete (× turns into "Delete" for 3 s). Data: /api/tasks.
import * as kit from '../../kit.js';

const { api, el, toast, haptic, navbar, section, emptyState, holdReload, releaseReload, store, icon } = kit;

const ARM_MS = 3_000;            // how long the "Delete" confirm stays armed
const DRAFT_KEY = 'tasks.draft'; // unsent text survives a reload
const HOLD_KEY = 'tasks:typing';

let state = null;
let els = null;
let listeners = [];

export default {
  mount(root) {
    state = { tasks: [], loaded: false, inflight: false };

    const input = el('input', {
      class: 'input task-input', type: 'text', name: 'text', placeholder: 'New task', maxlength: '2000',
      autocapitalize: 'sentences', autocorrect: 'on', enterkeyhint: 'done', 'aria-label': 'New task', autocomplete: 'off',
    });
    const add = el('button', { class: 'task-add', type: 'submit', text: 'Add' });
    const form = el('form', { class: 'task-form', autocomplete: 'off' }, input, add);
    const open = el('ul', { class: 'card list tasks', 'aria-label': 'Open tasks' });
    const empty = emptyState('Nothing here yet.');
    empty.hidden = true;
    const doneTitle = section('Done');
    doneTitle.hidden = true;
    const done = el('ul', { class: 'card list tasks tasks-done', 'aria-label': 'Done tasks' });
    done.hidden = true;

    root.append(navbar({ title: 'Tasks' }), el('div', { class: 'app-content' }, form, open, empty, doneTitle, done));
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
      addTask(text);
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
    const data = await api('/api/tasks');
    if (!state) return;
    state.tasks = sortTasks(Array.isArray(data.tasks) ? data.tasks : []);
    state.loaded = true;
    render();
  } catch {
    /* keep whatever is on screen; the banner reports the outage */
  } finally {
    if (state) state.inflight = false;
  }
}

// Open first (newest first), then done (newest first) -- same order as the server.
function sortTasks(list) {
  return list.slice().sort((a, b) =>
    (Number(a.done) - Number(b.done)) ||
    (Date.parse(b.created_at) - Date.parse(a.created_at)) ||
    (b.id - a.id));
}

function render() {
  if (!state || !els) return;
  const open = state.tasks.filter((t) => !t.done);
  const done = state.tasks.filter((t) => t.done);
  els.open.replaceChildren(...open.map(taskRow));
  els.done.replaceChildren(...done.map(taskRow));
  els.open.hidden = open.length === 0;
  els.done.hidden = done.length === 0;
  els.doneTitle.hidden = done.length === 0;
  els.empty.hidden = !(state.loaded && state.tasks.length === 0);
}

function taskRow(task) {
  const check = el('button', {
    class: 'check',
    type: 'button',
    role: 'checkbox',
    'aria-checked': String(Boolean(task.done)),
    'aria-label': task.done ? 'Mark as not done' : 'Mark as done',
    'on:click': () => toggleTask(task.id),
  }, icon('check', { size: 14, strokeWidth: 2.6 }));
  const del = el('button', { class: 'del', type: 'button', 'aria-label': 'Delete task', text: '×' });
  del.addEventListener('click', () => armDelete(del, task.id));
  return el('li', { class: task.pending ? 'task pending' : 'task', dataset: { id: task.id } },
    check, el('span', { class: 'text', text: task.text }), del);
}

// Quick confirm without a dialog: first tap turns the × into "Delete" for a few seconds, a
// second tap deletes.
function armDelete(button, id) {
  if (button.dataset.armed === 'true') {
    disarm(button);
    deleteTask(id);
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
  button.setAttribute('aria-label', 'Delete task');
}

function patchLocal(id, patch) {
  state.tasks = sortTasks(state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
}

function failureMessage(verb, err) {
  if (err && err.status === 404) return `That task is gone (${verb} skipped)`;
  if (err && err.status) return `Couldn't ${verb}: ${err.message}`;
  return `Couldn't ${verb} — the PC is unreachable`;
}

async function addTask(text) {
  if (!state) return;
  const tempId = -Date.now();
  const now = new Date().toISOString();
  state.tasks = sortTasks([{ id: tempId, text, done: false, created_at: now, updated_at: now, pending: true }, ...state.tasks]);
  state.loaded = true;
  render();
  haptic('success');
  try {
    const data = await api('/api/tasks', { method: 'POST', body: { text } });
    if (!state) return;
    state.tasks = sortTasks(state.tasks.map((t) => (t.id === tempId ? data.task : t)));
    render();
  } catch (err) {
    if (!state) return;
    state.tasks = state.tasks.filter((t) => t.id !== tempId);
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

async function toggleTask(id) {
  if (!state) return;
  const task = state.tasks.find((t) => t.id === id);
  if (!task || task.pending) return;
  const next = !task.done;
  haptic('light');
  patchLocal(id, { done: next });
  render();
  try {
    const data = await api(`/api/tasks/${id}`, { method: 'PATCH', body: { done: next } });
    if (!state) return;
    state.tasks = sortTasks(state.tasks.map((t) => (t.id === id ? data.task : t)));
    render();
  } catch (err) {
    if (!state) return;
    if (err && err.status === 404) state.tasks = state.tasks.filter((t) => t.id !== id);
    else patchLocal(id, { done: !next });
    render();
    toast(failureMessage('update', err), { kind: 'error' });
    haptic('error');
  }
}

async function deleteTask(id) {
  if (!state) return;
  const task = state.tasks.find((t) => t.id === id);
  if (!task || task.pending) return;
  state.tasks = state.tasks.filter((t) => t.id !== id);
  render();
  try {
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
  } catch (err) {
    if (!state) return;
    if (err && err.status === 404) return; // already gone: nothing to revert
    state.tasks = sortTasks([...state.tasks, task]);
    render();
    toast(failureMessage('delete', err), { kind: 'error' });
    haptic('error');
  }
}
