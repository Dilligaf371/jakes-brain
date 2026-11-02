// Calendar app: a month grid (Sunday first) with a day agenda below it and a full-screen
// add/edit editor. Data: /api/calendar/events?from&to (the visible grid's range).
//
// Day keys are local 'YYYY-MM-DD' strings made with kit.fmt.dayKey (never toISOString, which
// would shift a day across the UTC line). Sub-route #/calendar/YYYY-MM keeps the month on
// reload (#/calendar/YYYY-MM-DD also selects that day).
import * as kit from '../../kit.js';

const { api, el, fmt, toast, haptic, navbar, navButton, icon, emptyState, confirmSheet, holdReload, releaseReload, nav } = kit;

const HOLD_KEY = 'calendar:editor';   // the build-change reload waits while the editor is open
const SWIPE_PX = 50;                  // horizontal travel that flips the month
const SUB_RE = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let state = null;      // { year, month, selected, events: Map<dayKey, event[]>, range, loadSeq, editor }
let els = null;
let listeners = [];

export default {
  mount(root, ctx) {
    const today = fmt.dayKey();
    const parsed = parseSub(ctx && ctx.sub);
    state = {
      year: parsed ? parsed.year : Number(today.slice(0, 4)),
      month: parsed ? parsed.month : Number(today.slice(5, 7)) - 1,
      selected: null,
      events: new Map(),
      range: null,
      loadSeq: 0,
      loaded: false,
      editor: null,
    };
    state.selected = parsed && parsed.day ? parsed.day : defaultSelection(state.year, state.month);

    const addBtn = navButton({ icon: 'plus', label: 'New event', onClick: () => openEditor(null) });
    const prevBtn = el('button', { class: 'cal-nav-btn', type: 'button', 'aria-label': 'Previous month', 'on:click': () => goMonth(-1) }, icon('chevron-left', { size: 26, strokeWidth: 2.4 }));
    const nextBtn = el('button', { class: 'cal-nav-btn', type: 'button', 'aria-label': 'Next month', 'on:click': () => goMonth(1) }, icon('chevron-right', { size: 26, strokeWidth: 2.4 }));
    const todayBtn = el('button', { class: 'cal-today-btn', type: 'button', text: 'Today', 'on:click': goToday });
    const monthTitle = el('h2', { class: 'cal-month-title', 'aria-live': 'polite' });
    const head = el('div', { class: 'cal-head' }, monthTitle, todayBtn, prevBtn, nextBtn);

    const weekdays = el('div', { class: 'cal-weekdays', 'aria-hidden': 'true' }, weekdayNames().map((name) => el('span', { text: name })));
    const grid = el('div', { class: 'cal-grid', role: 'grid', 'aria-label': 'Month' });
    const month = el('div', { class: 'cal-month' }, weekdays, grid);

    const dayHead = el('h3', { class: 'cal-day-head' });
    const list = el('div', { class: 'card cal-list', role: 'list' });
    const empty = emptyState('No events');

    root.append(
      navbar({ title: 'Calendar', right: [addBtn] }),
      el('div', { class: 'app-content' }, head, month, dayHead, list, empty),
    );
    els = { root, addBtn, monthTitle, todayBtn, grid, month, dayHead, list, empty };

    // Swipe left/right on the grid flips the month (touch only; vertical scrolling stays native).
    let touch = null;
    listen(month, 'touchstart', (event) => {
      touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    }, { passive: true });
    listen(month, 'touchend', (event) => {
      if (!touch) return;
      const t = event.changedTouches[0];
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      touch = null;
      if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) goMonth(dx < 0 ? 1 : -1);
    }, { passive: true });
    listen(month, 'touchcancel', () => { touch = null; }, { passive: true });

    listen(document, 'keydown', onKeydown, true);
    listen(window, 'jakesdata:online', load);
    listen(window, 'jakesdata:foreground', load);
    listen(document, 'visibilitychange', () => { if (!document.hidden) load(); });

    renderAll();
    load();
  },

  // Hash changed inside the app: #/calendar/YYYY-MM (or YYYY-MM-DD).
  route(sub) {
    if (!state) return;
    const parsed = parseSub(sub);
    if (!parsed) {
      const today = fmt.dayKey();
      showMonth(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, today);
      return;
    }
    showMonth(parsed.year, parsed.month, parsed.day || null);
  },

  unmount() {
    for (const [target, type, fn, options] of listeners) target.removeEventListener(type, fn, options);
    listeners = [];
    releaseReload(HOLD_KEY);
    state = null;
    els = null;
  },
};

function listen(target, type, fn, options) {
  target.addEventListener(type, fn, options);
  listeners.push([target, type, fn, options]);
}

// ---------------------------------------------------------------- dates (all local time)

function parseSub(sub) {
  const m = SUB_RE.exec(String(sub || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  if (year < 1900 || year > 2999 || month < 0 || month > 11) return null;
  let day = null;
  if (m[3]) {
    const d = new Date(year, month, Number(m[3]));
    if (d.getMonth() !== month) return null;
    day = fmt.dayKey(d);
  }
  return { year, month, day };
}

function monthKey(year, month) {
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

function dateFromKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Today when the month contains it, else the 1st.
function defaultSelection(year, month) {
  const today = fmt.dayKey();
  return today.startsWith(monthKey(year, month)) ? today : fmt.dayKey(new Date(year, month, 1));
}

// The cells of a month grid: leading days of the previous month up to the first Sunday,
// the month, then trailing days to fill the last row. 4, 5 or 6 rows (Feb 2026 is 4).
function gridCells(year, month) {
  const offset = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const rows = Math.ceil((offset + daysInMonth) / 7);
  const cells = [];
  for (let i = 0; i < rows * 7; i++) {
    const date = new Date(year, month, 1 - offset + i);
    cells.push({ key: fmt.dayKey(date), day: date.getDate(), inMonth: date.getMonth() === month, date });
  }
  return cells;
}

function weekdayNames() {
  const sunday = new Date(2024, 0, 7); // a Sunday
  return Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3));
}

// '09:30' -> "9:30 AM"
function timeLabel(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  return fmt.time(new Date(2000, 0, 1, h, m));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------- navigation

function showMonth(year, month, selectKey) {
  if (!state) return;
  const changed = year !== state.year || month !== state.month;
  state.year = year;
  state.month = month;
  if (selectKey) state.selected = selectKey;
  else if (changed) state.selected = defaultSelection(year, month);
  renderAll();
  if (changed) load();
}

function goMonth(delta) {
  if (!state || state.editor) return;
  haptic('light');
  const d = new Date(state.year, state.month + delta, 1);
  animateGrid(delta);
  showMonth(d.getFullYear(), d.getMonth(), null);
  nav.replace(`#/calendar/${monthKey(state.year, state.month)}`);
}

function goToday() {
  if (!state || state.editor) return;
  haptic('light');
  const today = fmt.dayKey();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  if (year !== state.year || month !== state.month) animateGrid(new Date(year, month, 1) > new Date(state.year, state.month, 1) ? 1 : -1);
  showMonth(year, month, today);
  nav.replace(`#/calendar/${monthKey(year, month)}`);
}

function selectDay(cell) {
  if (!state) return;
  haptic('light');
  if (cell.inMonth) {
    state.selected = cell.key;
    renderGrid();
    renderList();
    return;
  }
  // A leading/trailing day of a neighbouring month: go there with that day selected.
  const d = cell.date;
  animateGrid(d < new Date(state.year, state.month, 1) ? -1 : 1);
  showMonth(d.getFullYear(), d.getMonth(), cell.key);
  nav.replace(`#/calendar/${monthKey(state.year, state.month)}`);
}

function animateGrid(direction) {
  if (reducedMotion || !els) return;
  const node = els.grid;
  node.classList.remove('slide-left', 'slide-right');
  void node.offsetWidth; // restart the animation
  node.classList.add(direction > 0 ? 'slide-left' : 'slide-right');
}

function onKeydown(event) {
  if (!state) return;
  const sheet = document.getElementById('sheet');
  if (sheet && !sheet.hidden) return; // a kit sheet (confirm) is up: leave the keys to it
  if (state.editor) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      // Same policy as the launcher: a focused field only loses focus (a half-typed title is
      // not thrown away by reflex); the next Escape closes the editor.
      const active = document.activeElement;
      if (active && state.editor.modal.contains(active) && active.matches('input, textarea, select')) active.blur();
      else closeEditor();
    }
    return;
  }
  const t = event.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (event.key === 'ArrowLeft') goMonth(-1);
  else if (event.key === 'ArrowRight') goMonth(1);
}

// ---------------------------------------------------------------- data

async function load() {
  if (!state || !els) return;
  const cells = gridCells(state.year, state.month);
  const from = cells[0].key;
  const to = cells[cells.length - 1].key;
  const seq = ++state.loadSeq;
  try {
    const data = await api(`/api/calendar/events?from=${from}&to=${to}`);
    if (!state || state.loadSeq !== seq) return; // a newer month is on screen
    const map = new Map();
    for (const ev of Array.isArray(data.events) ? data.events : []) {
      if (!map.has(ev.date)) map.set(ev.date, []);
      map.get(ev.date).push(ev);
    }
    for (const list of map.values()) list.sort(compareEvents);
    state.events = map;
    state.range = { from, to };
    state.loaded = true;
    renderGrid();
    renderList();
  } catch {
    /* keep what is on screen; the banner reports the outage */
  }
}

// All-day first, then by start time, then title.
function compareEvents(a, b) {
  if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
  const ta = a.start_time || '';
  const tb = b.start_time || '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return String(a.title).localeCompare(String(b.title)) || (a.id - b.id);
}

function eventsOn(key) {
  return (state && state.events.get(key)) || [];
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderHead();
  renderGrid();
  renderList();
}

function renderHead() {
  if (!state || !els) return;
  els.monthTitle.textContent = new Date(state.year, state.month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function renderGrid() {
  if (!state || !els) return;
  const today = fmt.dayKey();
  const cells = gridCells(state.year, state.month);
  els.grid.replaceChildren(...cells.map((cell) => {
    const count = eventsOn(cell.key).length;
    const selected = cell.key === state.selected;
    const isToday = cell.key === today;
    const classes = ['cal-day'];
    if (!cell.inMonth) classes.push('other');
    if (isToday) classes.push('today');
    if (count) classes.push('has-events');
    const label = `${fmt.date(cell.date, { weekday: 'long', month: 'long', day: true, year: false })}` +
      (isToday ? ', today' : '') + (count ? `, ${count} event${count === 1 ? '' : 's'}` : '');
    return el('button', {
      class: classes.join(' '),
      type: 'button',
      role: 'gridcell',
      'aria-pressed': String(selected),
      'aria-current': isToday ? 'date' : null,
      'aria-label': label,
      dataset: { key: cell.key },
      'on:click': () => selectDay(cell),
    }, el('span', { class: 'num', text: String(cell.day) }), el('span', { class: 'dot' }));
  }));
}

function renderList() {
  if (!state || !els) return;
  const key = state.selected;
  const date = dateFromKey(key);
  const isToday = key === fmt.dayKey();
  // replaceChildren() would stringify a null into a "null" text node, so build the list first.
  const headParts = [el('span', { text: fmt.date(date, { weekday: 'long', month: 'long', day: true, year: date.getFullYear() !== new Date().getFullYear() }) })];
  if (isToday) headParts.push(el('span', { class: 'tag', text: 'Today' }));
  els.dayHead.replaceChildren(...headParts);
  const events = eventsOn(key);
  els.list.replaceChildren(...events.map(eventRow));
  els.list.hidden = events.length === 0;
  els.empty.hidden = events.length > 0;
}

function eventRow(ev) {
  const when = el('span', { class: 'cal-when' });
  if (ev.all_day) {
    when.append(el('span', { class: 'start', text: 'all-day' }));
  } else {
    when.append(el('span', { class: 'start', text: timeLabel(ev.start_time) }));
    if (ev.end_time) when.append(el('span', { class: 'end', text: timeLabel(ev.end_time) }));
  }
  const firstLine = String(ev.notes || '').split('\n').find((l) => l.trim()) || '';
  return el('button', {
    class: 'cal-event',
    type: 'button',
    role: 'listitem',
    dataset: { id: ev.id },
    'aria-label': `${ev.title}, ${ev.all_day ? 'all day' : timeLabel(ev.start_time)}`,
    'on:click': () => openEditor(ev),
  },
  when,
  el('span', { class: 'cal-bar', 'aria-hidden': 'true' }),
  el('span', { class: 'cal-what' },
    el('span', { class: 'cal-title', text: ev.title }),
    firstLine ? el('span', { class: 'cal-note', text: firstLine }) : null));
}

// ---------------------------------------------------------------- editor (add / edit)

// Default times for a new event: the next full hour when the day is today, else 9:00.
function defaultTimes(dateKey) {
  const now = new Date();
  let h = 9;
  if (dateKey === fmt.dayKey(now)) h = Math.min(23, now.getHours() + 1);
  const end = Math.min(23, h + 1);
  return { start: `${pad2(h)}:00`, end: h >= 23 ? '23:59' : `${pad2(end)}:00` };
}

function openEditor(existing) {
  if (!state || !els || state.editor) return;
  haptic('light');
  const isNew = !existing;
  const initialDate = existing ? existing.date : state.selected;
  const defaults = defaultTimes(initialDate);

  const title = el('input', {
    class: 'input bare cal-title-input', type: 'text', name: 'title', placeholder: 'Title', maxlength: '200',
    autocapitalize: 'sentences', autocorrect: 'on', enterkeyhint: 'done', autocomplete: 'off', 'aria-label': 'Title',
    value: existing ? existing.title : '',
  });
  const allDay = el('input', { class: 'cal-switch-input', type: 'checkbox', name: 'all_day', role: 'switch' });
  allDay.checked = existing ? Boolean(existing.all_day) : false;
  const date = el('input', { class: 'cal-native', type: 'date', name: 'date', 'aria-label': 'Date', required: true, value: initialDate });
  const start = el('input', { class: 'cal-native', type: 'time', name: 'start_time', 'aria-label': 'Starts', value: existing && existing.start_time ? existing.start_time : defaults.start });
  const end = el('input', { class: 'cal-native', type: 'time', name: 'end_time', 'aria-label': 'Ends', value: existing && existing.end_time ? existing.end_time : (existing && !existing.all_day ? '' : defaults.end) });
  const notes = el('textarea', { class: 'input bare cal-notes', name: 'notes', placeholder: 'Notes', rows: '3', maxlength: '4000', 'aria-label': 'Notes' });
  notes.value = existing ? existing.notes || '' : '';

  const dateRow = el('label', { class: 'row cal-field' }, el('span', { class: 'label', text: 'Date' }), date);
  const startRow = el('label', { class: 'row cal-field' }, el('span', { class: 'label', text: 'Starts' }), start);
  const endRow = el('label', { class: 'row cal-field' }, el('span', { class: 'label', text: 'Ends' }), end);
  const syncAllDay = () => {
    startRow.hidden = allDay.checked;
    endRow.hidden = allDay.checked;
    dateRow.classList.toggle('cal-last', allDay.checked); // no hairline under the last visible row
  };
  allDay.addEventListener('change', () => {
    haptic('light');
    if (!allDay.checked && !start.value) {
      const d = defaultTimes(date.value || initialDate);
      start.value = d.start;
      if (!end.value) end.value = d.end;
    }
    syncAllDay();
  });
  syncAllDay();

  const cancel = el('button', { class: 'nav-btn cal-cancel', type: 'button', text: 'Cancel', 'on:click': () => closeEditor() });
  const save = el('button', { class: 'nav-btn primary cal-save', type: 'submit', text: isNew ? 'Add' : 'Save', form: 'cal-editor-form' });
  const syncSave = () => { save.disabled = title.value.trim().length === 0; };
  title.addEventListener('input', syncSave);
  syncSave();

  const autoGrow = () => {
    notes.style.height = 'auto';
    notes.style.height = `${Math.max(72, notes.scrollHeight)}px`;
  };
  notes.addEventListener('input', autoGrow);

  const form = el('form', { class: 'cal-editor-body', id: 'cal-editor-form', autocomplete: 'off' },
    el('div', { class: 'card cal-form' }, title),
    el('div', { class: 'card cal-form' },
      el('label', { class: 'row cal-field' }, el('span', { class: 'label', text: 'All-day' }),
        el('span', { class: 'cal-switch' }, allDay, el('span', { class: 'cal-switch-track', 'aria-hidden': 'true' }, el('span', { class: 'cal-switch-knob' })))),
      dateRow,
      startRow,
      endRow),
    el('div', { class: 'card cal-form' }, notes),
    existing ? el('button', { class: 'button destructive cal-delete', type: 'button', text: 'Delete Event', 'on:click': () => deleteEvent(existing) }) : null);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitEditor();
  });

  const panel = el('div', { class: 'cal-editor', role: 'dialog', 'aria-modal': 'true', 'aria-label': isNew ? 'New event' : 'Edit event' },
    el('div', { class: 'cal-editor-bar' }, cancel, el('h2', { text: isNew ? 'New Event' : 'Edit Event' }), save),
    form);
  const modal = el('div', { class: 'cal-modal' }, el('div', { class: 'cal-modal-backdrop', 'on:click': () => closeEditor() }), panel);
  els.root.append(modal);
  holdReload(HOLD_KEY);
  state.editor = { modal, existing, fields: { title, allDay, date, start, end, notes }, save, busy: false };
  requestAnimationFrame(() => {
    autoGrow();
    if (isNew) title.focus();
  });
}

function closeEditor() {
  if (!state || !state.editor) return;
  const { modal } = state.editor;
  state.editor = null;
  releaseReload(HOLD_KEY);
  modal.classList.add('out');
  setTimeout(() => modal.remove(), reducedMotion ? 0 : 180);
}

function readEditor() {
  const { title, allDay, date, start, end, notes } = state.editor.fields;
  const body = {
    title: title.value.trim(),
    date: date.value,
    all_day: allDay.checked,
    notes: notes.value.trim(),
    start_time: allDay.checked ? null : (start.value || null),
    end_time: allDay.checked ? null : (end.value || null),
  };
  if (!body.title) return { error: 'Give the event a title' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return { error: 'Pick a date' };
  if (!body.all_day) {
    if (!body.start_time) return { error: 'Pick a start time' };
    if (body.end_time && body.end_time < body.start_time) return { error: 'The end is before the start' };
  }
  return { body };
}

async function submitEditor() {
  if (!state || !state.editor || state.editor.busy) return;
  const editor = state.editor;
  const { body, error } = readEditor();
  if (error) {
    toast(error, { kind: 'error' });
    haptic('error');
    return;
  }
  editor.busy = true;
  editor.save.disabled = true;
  try {
    const data = editor.existing
      ? await api(`/api/calendar/events/${editor.existing.id}`, { method: 'PATCH', body })
      : await api('/api/calendar/events', { method: 'POST', body });
    if (!state) return;
    const saved = data && data.event ? data.event : body;
    closeEditor();
    haptic('success');
    // Show the day the event landed on (it may be in another month now).
    const d = dateFromKey(saved.date);
    showMonth(d.getFullYear(), d.getMonth(), saved.date);
    nav.replace(`#/calendar/${monthKey(state.year, state.month)}`);
    load();
  } catch (err) {
    if (!state || state.editor !== editor) return;
    editor.busy = false;
    editor.save.disabled = false;
    toast(failureMessage('save', err), { kind: 'error' });
    haptic('error');
  }
}

async function deleteEvent(ev) {
  if (!state || !state.editor || state.editor.busy) return;
  const ok = await confirmSheet({ title: 'Delete this event?', message: ev.title, confirmLabel: 'Delete', destructive: true });
  if (!ok || !state || !state.editor) return;
  const editor = state.editor;
  editor.busy = true;
  try {
    await api(`/api/calendar/events/${ev.id}`, { method: 'DELETE' });
  } catch (err) {
    if (!state) return;
    if (!(err && err.status === 404)) { // already gone: treat as deleted
      editor.busy = false;
      toast(failureMessage('delete', err), { kind: 'error' });
      haptic('error');
      return;
    }
  }
  if (!state) return;
  closeEditor();
  haptic('success');
  load();
}

function failureMessage(verb, err) {
  if (err && err.status === 404) return `That event is gone (${verb} skipped)`;
  if (err && err.status) return `Couldn't ${verb}: ${err.message}`;
  return `Couldn't ${verb} — the PC is unreachable`;
}
