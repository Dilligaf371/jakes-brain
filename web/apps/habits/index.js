// Habits app: one row per habit — colour dot, name, streak ("12 days") and a 7-day strip of
// circles with today rightmost. Today and yesterday toggle (optimistic, reverted on failure);
// older days are read-only. `+` opens a sheet with a name field and 6 colour swatches; `…`
// opens Edit / Archive / Delete (delete via confirmSheet). Archived habits sit in their own
// section with Unarchive / Delete. Data: /api/habits (server/apps/habits.js); the phone sends
// its own local `today` so day keys are the phone's days.
import * as kit from '../../kit.js';

const {
  api, el, fmt, toast, haptic, navbar, navButton, section, emptyState, confirmSheet, actionSheet,
  holdReload, releaseReload, icon,
} = kit;

const DAYS = 7;
const NAME_MAX = 100;
const HOLD_KEY = 'habits:sheet';
const COLORS = [
  { value: '#ff9f0a', label: 'Orange' },
  { value: '#ff453a', label: 'Red' },
  { value: '#30d158', label: 'Green' },
  { value: '#0a84ff', label: 'Blue' },
  { value: '#bf5af2', label: 'Purple' },
  { value: '#64d2ff', label: 'Teal' },
];

let state = null;
let els = null;
let listeners = [];
let sheet = null;        // the open form sheet: { node, panel, onKey, onViewport }
let midnightTimer = 0;

export default {
  mount(root) {
    const today = fmt.dayKey();
    state = { habits: [], loaded: false, inflight: false, today, dates: datesEndingAt(today, DAYS), pending: new Set() };

    const add = navButton({ icon: 'plus', label: 'New habit', onClick: () => openForm(null) });
    const list = el('ul', { class: 'card list habits', 'aria-label': 'Habits' });
    const empty = emptyState('No habits yet. Tap + to add one.');
    empty.hidden = true;
    const archivedTitle = section('Archived');
    archivedTitle.hidden = true;
    const archived = el('ul', { class: 'card list habits habits-archived', 'aria-label': 'Archived habits' });
    archived.hidden = true;

    root.append(navbar({ title: 'Habits', right: [add] }), el('div', { class: 'app-content' }, list, empty, archivedTitle, archived));
    els = { root, list, empty, archivedTitle, archived };

    load();
    listen(window, 'jakesdata:online', load);
    listen(window, 'jakesdata:foreground', load);
    listen(document, 'visibilitychange', () => { if (!document.hidden) load(); });
    scheduleMidnight();
  },

  unmount() {
    closeForm();
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners = [];
    clearTimeout(midnightTimer);
    midnightTimer = 0;
    releaseReload(HOLD_KEY);
    state = null;
    els = null;
  },
};

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  listeners.push([target, type, fn]);
}

// ---------------------------------------------------------------- day keys (local)

function parseDay(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(key, n) {
  const d = parseDay(key);
  d.setDate(d.getDate() + n);
  return fmt.dayKey(d);
}

function datesEndingAt(today, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}

// The strip (and "today") rolls over at midnight without a reload.
function scheduleMidnight() {
  clearTimeout(midnightTimer);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2);
  midnightTimer = setTimeout(() => {
    load();
    scheduleMidnight();
  }, Math.max(1000, next - now));
}

// ---------------------------------------------------------------- data

function windowQuery() {
  return `?days=${DAYS}&today=${state.today}`;
}

function normalize(h) {
  return {
    id: Number(h.id),
    name: String(h.name || ''),
    color: typeof h.color === 'string' ? h.color : COLORS[0].value,
    archived: Boolean(h.archived),
    created_at: h.created_at,
    checks: Array.isArray(h.checks) ? h.checks.map(String) : [],
    streak: Number(h.streak) || 0,
  };
}

async function load() {
  if (!state || state.inflight) return;
  state.inflight = true;
  const today = fmt.dayKey();
  try {
    const data = await api(`/api/habits?days=${DAYS}&today=${today}`);
    if (!state) return;
    state.today = today;
    state.dates = datesEndingAt(today, DAYS);
    state.habits = Array.isArray(data.habits) ? data.habits.map(normalize) : [];
    state.loaded = true;
    render();
  } catch {
    /* keep whatever is on screen; the banner reports the outage */
  } finally {
    if (state) state.inflight = false;
  }
}

function findHabit(id) {
  return state ? state.habits.find((h) => h.id === id) : null;
}

function replaceHabit(habit) {
  state.habits = state.habits.map((h) => (h.id === habit.id ? habit : h));
}

function failureMessage(verb, err) {
  if (err && err.status === 404) return `That habit is gone (${verb} skipped)`;
  if (err && err.status) return `Couldn't ${verb}: ${err.message}`;
  return `Couldn't ${verb} — the PC is unreachable`;
}

// ---------------------------------------------------------------- render

function render() {
  if (!state || !els) return;
  const active = state.habits.filter((h) => !h.archived);
  const archived = state.habits.filter((h) => h.archived);
  els.list.replaceChildren(...active.map(habitRow));
  els.archived.replaceChildren(...archived.map(archivedRow));
  els.list.hidden = active.length === 0;
  els.empty.hidden = !(state.loaded && active.length === 0);
  els.empty.textContent = archived.length ? 'No active habits.' : 'No habits yet. Tap + to add one.';
  els.archivedTitle.hidden = archived.length === 0;
  els.archived.hidden = archived.length === 0;
}

// Re-draws one row in place (a toggle must not rebuild the whole list).
function renderRow(id) {
  if (!state || !els) return;
  const habit = findHabit(id);
  const old = els.root.querySelector(`.habit[data-id="${id}"]`);
  if (!habit || !old) {
    render();
    return;
  }
  const fresh = habit.archived ? archivedRow(habit) : habitRow(habit);
  if ((old.parentNode === els.archived) !== habit.archived) {
    render();
    return;
  }
  old.replaceWith(fresh);
}

function streakLabel(n) {
  return n === 1 ? '1 day' : `${n} days`;
}

function moreButton(habit) {
  return el('button', {
    class: 'more', type: 'button', 'aria-label': `More for ${habit.name}`, 'on:click': () => openMenu(habit.id),
  }, icon('more'));
}

function habitRow(habit) {
  const checks = new Set(habit.checks);
  const strip = el('div', { class: 'strip', role: 'group', 'aria-label': `${habit.name}, last ${DAYS} days` },
    state.dates.map((date) => dayCell(habit, date, checks.has(date))));
  return el('li', { class: 'habit', dataset: { id: habit.id }, style: `--c:${habit.color}` },
    el('div', { class: 'head' },
      el('span', { class: 'dot' }),
      el('span', { class: 'name', text: habit.name }),
      el('span', { class: `streak${habit.streak ? '' : ' zero'}`, text: streakLabel(habit.streak) }),
      moreButton(habit)),
    strip);
}

function archivedRow(habit) {
  return el('li', { class: 'habit archived', dataset: { id: habit.id }, style: `--c:${habit.color}` },
    el('div', { class: 'head' },
      el('span', { class: 'dot' }),
      el('span', { class: 'name', text: habit.name }),
      el('span', { class: 'streak zero', text: 'Archived' }),
      moreButton(habit)));
}

function dayCell(habit, date, checked) {
  const today = state.today;
  const editable = date === today || date === addDays(today, -1);
  const d = parseDay(date);
  const cls = ['day'];
  if (date === today) cls.push('today');
  if (!editable) cls.push('locked');
  if (checked) cls.push('on');
  const when = date === today ? 'Today' : fmt.date(d, { weekday: 'long', month: 'long' });
  const btn = el('button', {
    class: cls.join(' '),
    type: 'button',
    role: 'checkbox',
    'aria-checked': String(checked),
    'aria-label': `${when}, ${checked ? 'done' : 'not done'}`,
    'aria-disabled': editable ? null : 'true',
    tabindex: editable ? null : '-1',
  },
  el('span', { class: 'circle' }, icon('check', { size: 14, strokeWidth: 2.6 })),
  el('span', { class: 'wd', 'aria-hidden': 'true', text: d.toLocaleDateString(undefined, { weekday: 'narrow' }) }));
  if (editable) btn.addEventListener('click', () => toggle(habit.id, date));
  return btn;
}

// ---------------------------------------------------------------- toggling (optimistic)

// The streak the server will most likely answer with, so the number moves with the tap.
// Exact for today; for yesterday it is exact unless the chain runs past the 7-day window
// (the server's reply corrects it a moment later).
function estimate(habit, date, on) {
  const today = state.today;
  const yesterday = addDays(today, -1);
  const checks = on ? [...new Set([...habit.checks, date])].sort() : habit.checks.filter((d) => d !== date);
  const set = new Set(checks);
  let streak = habit.streak;
  if (date === today) {
    streak = on ? habit.streak + 1 : Math.max(0, habit.streak - 1);
  } else if (date === yesterday) {
    if (!on) {
      streak = set.has(today) ? 1 : 0;
    } else {
      let n = 0;
      let cursor = addDays(yesterday, -1);
      while (set.has(cursor)) {
        n += 1;
        cursor = addDays(cursor, -1);
      }
      streak = (set.has(today) ? 1 : 0) + 1 + n;
    }
  }
  return { checks, streak };
}

async function toggle(id, date) {
  if (!state) return;
  const habit = findHabit(id);
  if (!habit) return;
  const key = `${id}:${date}`;
  if (state.pending.has(key)) return;
  const on = !habit.checks.includes(date);
  const before = { checks: habit.checks, streak: habit.streak };
  haptic(on && date === state.today ? 'success' : 'light');
  state.pending.add(key);
  replaceHabit({ ...habit, ...estimate(habit, date, on) });
  renderRow(id);
  try {
    const data = await api(`/api/habits/${id}/checks/${date}${windowQuery()}`, { method: on ? 'PUT' : 'DELETE' });
    if (!state) return;
    if (data && data.habit) replaceHabit(normalize(data.habit));
    renderRow(id);
  } catch (err) {
    if (!state) return;
    if (err && err.status === 404) {
      state.habits = state.habits.filter((h) => h.id !== id);
      render();
    } else {
      const current = findHabit(id);
      if (current) replaceHabit({ ...current, ...before });
      renderRow(id);
    }
    toast(failureMessage(on ? 'check it off' : 'uncheck it', err), { kind: 'error' });
    haptic('error');
  } finally {
    if (state) state.pending.delete(key);
  }
}

// ---------------------------------------------------------------- menu + edits

async function openMenu(id) {
  const habit = findHabit(id);
  if (!habit) return;
  const actions = habit.archived
    ? [{ label: 'Unarchive', value: 'unarchive' }, { label: 'Delete', value: 'delete', destructive: true }]
    : [{ label: 'Edit', value: 'edit' }, { label: 'Archive', value: 'archive' }, { label: 'Delete', value: 'delete', destructive: true }];
  const choice = await actionSheet({ title: habit.name, actions });
  if (!state || !choice) return;
  if (choice === 'edit') {
    openForm(findHabit(id));
  } else if (choice === 'archive' || choice === 'unarchive') {
    setArchived(id, choice === 'archive');
  } else if (choice === 'delete') {
    const ok = await confirmSheet({
      title: `Delete "${habit.name}"?`,
      message: 'Its check-ins are deleted too.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (ok && state) deleteHabit(id);
  }
}

async function createHabit({ name, color }) {
  const data = await api(`/api/habits${windowQuery()}`, { method: 'POST', body: { name, color } });
  if (!state) return;
  const habit = normalize(data.habit);
  state.habits = [habit, ...state.habits.filter((h) => h.id !== habit.id)];
  state.loaded = true;
  render();
  haptic('success');
}

async function saveHabit(id, { name, color }) {
  const data = await api(`/api/habits/${id}${windowQuery()}`, { method: 'PATCH', body: { name, color } });
  if (!state) return;
  replaceHabit(normalize(data.habit));
  renderRow(id);
}

async function setArchived(id, archived) {
  const habit = findHabit(id);
  if (!habit || habit.archived === archived) return;
  haptic('light');
  replaceHabit({ ...habit, archived });
  render();
  try {
    const data = await api(`/api/habits/${id}${windowQuery()}`, { method: 'PATCH', body: { archived } });
    if (!state) return;
    replaceHabit(normalize(data.habit));
    render();
  } catch (err) {
    if (!state) return;
    if (err && err.status === 404) state.habits = state.habits.filter((h) => h.id !== id);
    else {
      const current = findHabit(id);
      if (current) replaceHabit({ ...current, archived: !archived });
    }
    render();
    toast(failureMessage(archived ? 'archive' : 'unarchive', err), { kind: 'error' });
    haptic('error');
  }
}

async function deleteHabit(id) {
  const habit = findHabit(id);
  if (!habit) return;
  const index = state.habits.indexOf(habit);
  state.habits = state.habits.filter((h) => h.id !== id);
  render();
  try {
    await api(`/api/habits/${id}`, { method: 'DELETE' });
  } catch (err) {
    if (!state) return;
    if (err && err.status === 404) return; // already gone: nothing to put back
    const list = state.habits.slice();
    list.splice(Math.min(index, list.length), 0, habit);
    state.habits = list;
    render();
    toast(failureMessage('delete', err), { kind: 'error' });
    haptic('error');
  }
}

// ---------------------------------------------------------------- form sheet (new / edit)

function openForm(habit) {
  if (!state || !els) return;
  closeForm();
  const editing = Boolean(habit);
  let color = editing && COLORS.some((c) => c.value === habit.color) ? habit.color : (editing ? habit.color : COLORS[0].value);

  const input = el('input', {
    class: 'input', type: 'text', name: 'name', placeholder: 'Name', maxlength: String(NAME_MAX),
    autocapitalize: 'words', autocorrect: 'on', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Habit name',
    value: editing ? habit.name : '',
  });
  const swatches = COLORS.map((c) => el('button', {
    class: 'swatch', type: 'button', role: 'radio', 'aria-checked': String(c.value === color), 'aria-label': c.label,
    style: `--c:${c.value}`,
  }));
  const pick = (value) => {
    color = value;
    for (const s of swatches) s.setAttribute('aria-checked', String(s.style.getPropertyValue('--c') === value));
  };
  swatches.forEach((s, i) => {
    // Keep the keyboard up and the name field focused while picking a colour.
    s.addEventListener('mousedown', (event) => event.preventDefault());
    s.addEventListener('click', () => {
      haptic('light');
      pick(COLORS[i].value);
    });
  });
  const submit = el('button', { class: 'primary', type: 'submit', text: editing ? 'Save' : 'Add' });
  const syncSubmit = () => { submit.disabled = input.value.trim().length === 0; };
  syncSubmit();
  input.addEventListener('input', syncSubmit);

  const form = el('form', { class: 'form', autocomplete: 'off' },
    el('h2', { class: 'title', text: editing ? 'Edit habit' : 'New habit' }),
    input,
    el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colour' }, swatches),
    submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    submit.disabled = true;
    try {
      if (editing) await saveHabit(habit.id, { name, color });
      else await createHabit({ name, color });
      closeForm();
    } catch (err) {
      if (!state) return;
      syncSubmit();
      toast(failureMessage(editing ? 'save' : 'add', err), { kind: 'error' });
      haptic('error');
    }
  });

  const cancel = el('button', { class: 'cancel', type: 'button', text: 'Cancel', 'on:click': () => closeForm() });
  const backdrop = el('div', { class: 'backdrop', 'on:click': () => closeForm() });
  const panel = el('div', { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': editing ? 'Edit habit' : 'New habit' },
    el('div', { class: 'group' }, form),
    el('div', { class: 'group' }, cancel));
  const node = el('div', { class: 'sheet' }, backdrop, panel);

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeForm();
    }
  };
  // Keep the sheet above the iOS keyboard: the visual viewport shrinks, the layout one does not.
  const onViewport = () => {
    const vv = window.visualViewport;
    if (!vv || !sheet) return;
    const covered = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
    panel.style.transform = covered > 0 ? `translateY(-${Math.round(covered)}px)` : '';
  };
  document.addEventListener('keydown', onKey);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onViewport);
    window.visualViewport.addEventListener('scroll', onViewport);
  }

  for (const stale of els.root.querySelectorAll(':scope > .sheet')) stale.remove(); // one still fading out
  els.root.append(node);
  holdReload(HOLD_KEY); // typing: never yank the keyboard away with a build-change reload
  sheet = { node, panel, onKey, onViewport };
  requestAnimationFrame(() => {
    if (sheet && sheet.node === node) input.focus();
  });
}

function closeForm() {
  if (!sheet) return;
  const { node, onKey, onViewport } = sheet;
  sheet = null;
  document.removeEventListener('keydown', onKey);
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', onViewport);
    window.visualViewport.removeEventListener('scroll', onViewport);
  }
  releaseReload(HOLD_KEY);
  node.classList.add('out');
  setTimeout(() => node.remove(), 170);
}
