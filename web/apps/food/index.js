// Food app: calorie + macro log. Day view (‹ date ›, totals against goals, entries by meal) and a
// History view (last 30 days). Claude logs most entries through the connector; here Jake can
// look, fix, add, and re-add a usual food in one tap. Data: /api/food. Sub-routes:
// #/food/2026-11-02 (a day), #/food/history.
import * as kit from '../../kit.js';
import { formSheet } from '../../form.js';

const { api, el, toast, haptic, navbar, navButton, section, emptyState, fmt } = kit;

const MEALS = [
  ['breakfast', 'Breakfast'],
  ['lunch', 'Lunch'],
  ['dinner', 'Dinner'],
  ['snack', 'Snacks'],
];
const MACROS = [
  ['protein', 'Protein', 'var(--food-p)'],
  ['carbs', 'Carbs', 'var(--food-c)'],
  ['fat', 'Fat', 'var(--food-f)'],
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const POLL_MS = 30_000; // Claude logs from elsewhere: keep the open day fresh

let state = null;
let els = null;
let listeners = [];
let timer = null;

export default {
  mount(root, ctx) {
    state = { view: 'day', date: todayKey(), day: null, days: null, goals: {}, recent: [], seq: 0 };
    const segments = el('div', { class: 'segmented food-seg', role: 'tablist', 'aria-label': 'Food' });
    const add = navButton({ icon: 'plus', label: 'Add food', onClick: () => addEntry() });
    const bar = navbar({ title: 'Food', right: [add] });
    const content = el('div', { class: 'app-content' });
    root.append(bar, content);
    els = { root, bar, add, segments, content, ctx };
    applyRoute(ctx.sub || '');
    listen(window, 'jakesdata:online', refresh);
    listen(window, 'jakesdata:foreground', refresh);
    listen(document, 'visibilitychange', () => { if (!document.hidden) refresh(); });
    timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  },

  route(sub) {
    if (state) applyRoute(sub || '');
  },

  unmount() {
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners = [];
    clearInterval(timer);
    state = null;
    els = null;
  },
};

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  listeners.push([target, type, fn]);
}

function applyRoute(sub) {
  if (sub === 'history') {
    state.view = 'history';
  } else {
    state.view = 'day';
    state.date = DATE_RE.test(sub) ? sub : todayKey();
  }
  render();
  refresh();
}

function go(sub) {
  els.ctx.nav.go(sub ? `#/food/${sub}` : '#/food');
}

// ---------------------------------------------------------------- dates

function todayKey() {
  return fmt.dayKey(new Date());
}

function shift(date, n) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return fmt.dayKey(d);
}

function dayTitle(date) {
  const t = todayKey();
  if (date === t) return 'Today';
  if (date === shift(t, -1)) return 'Yesterday';
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
}

// ---------------------------------------------------------------- data

async function refresh() {
  if (!state) return;
  const seq = ++state.seq;
  try {
    if (state.view === 'history') {
      const data = await api(`/api/food/days?from=${shift(todayKey(), -29)}&to=${todayKey()}`);
      if (!state || seq !== state.seq) return;
      state.days = data.days || [];
      state.goals = data.goals || {};
    } else {
      const date = state.date;
      const [day, recent] = await Promise.all([api(`/api/food/day/${date}`), state.recent.length ? null : api('/api/food/recent').catch(() => null)]);
      if (!state || seq !== state.seq || date !== state.date) return;
      state.day = day;
      state.goals = day.goals || {};
      if (recent) state.recent = recent.foods || [];
    }
    render();
  } catch {
    /* keep what is on screen; the banner reports an outage */
  }
}

// ---------------------------------------------------------------- render

function render() {
  if (!state || !els) return;
  els.segments.replaceChildren(
    segButton('Day', state.view === 'day', () => go(state.date === todayKey() ? '' : state.date)),
    segButton('History', state.view === 'history', () => go('history')),
  );
  els.add.hidden = state.view !== 'day';
  const top = el('div', { class: 'food-top' }, els.segments);
  if (state.view === 'history') els.content.replaceChildren(top, ...renderHistory());
  else els.content.replaceChildren(top, ...renderDay());
}

function segButton(label, on, onClick) {
  return el('button', { type: 'button', role: 'tab', 'aria-pressed': String(on), 'aria-selected': String(on), text: label, 'on:click': onClick });
}

function n0(v) {
  return Math.round(v || 0).toLocaleString();
}

function renderDay() {
  const date = state.date;
  const dayData = state.day && state.day.date === date ? state.day : null;
  const isToday = date === todayKey();
  const header = el('div', { class: 'food-datebar' },
    el('button', { class: 'food-arrow', type: 'button', 'aria-label': 'Previous day', 'on:click': () => go(shift(date, -1)) }, kit.icon('chevron-left', { size: 22 })),
    el('div', { class: 'food-date' },
      el('strong', { text: dayTitle(date) }),
      isToday ? null : el('button', { class: 'food-today', type: 'button', text: 'Today', 'on:click': () => go('') })),
    el('button', { class: 'food-arrow', type: 'button', 'aria-label': 'Next day', disabled: isToday, 'on:click': () => go(shift(date, 1)) }, kit.icon('chevron-right', { size: 22 })));

  if (!dayData) return [header, el('div', { class: 'card food-summary food-loading' })];
  const totals = dayData.totals;
  const goals = state.goals;

  const calGoal = goals.calories;
  const left = calGoal ? calGoal - totals.calories : null;
  const summary = el('div', { class: 'card food-summary' },
    el('button', { class: 'food-cal', type: 'button', 'aria-label': 'Set daily goals', 'on:click': editGoals },
      el('div', { class: 'food-cal-num' }, el('span', { class: 'big', text: n0(totals.calories) }), el('span', { class: 'unit', text: calGoal ? ` / ${n0(calGoal)} cal` : ' cal' })),
      el('div', { class: 'food-cal-sub', text: calGoal ? (left >= 0 ? `${n0(left)} left` : `${n0(-left)} over`) : 'Tap to set a goal' })),
    calGoal ? bar(totals.calories / calGoal, left < 0 ? 'var(--red)' : 'var(--accent)') : null,
    el('div', { class: 'food-macros' }, ...MACROS.map(([k, label, color]) => {
      const g = goals[k];
      return el('div', { class: 'food-macro' },
        el('div', { class: 'food-macro-label' }, el('span', { class: 'swatch', style: { background: color } }), label),
        el('div', { class: 'food-macro-num', text: g ? `${n0(totals[k])} / ${n0(g)} g` : `${n0(totals[k])} g` }),
        bar(g ? totals[k] / g : 0, color));
    })));

  const out = [header, summary];
  if (!dayData.entries.length) {
    out.push(emptyState(isToday ? 'Nothing logged yet today. Tell Claude what you ate, or tap +.' : 'Nothing logged this day.'));
  }
  for (const [meal, label] of MEALS) {
    const list = dayData.entries.filter((e) => e.meal === meal);
    if (!list.length) continue;
    const kcal = list.reduce((s, e) => s + (e.calories || 0), 0);
    out.push(el('div', { class: 'food-meal-head' }, section(label), el('span', { class: 'food-meal-cal', text: `${n0(kcal)} cal` })));
    out.push(el('ul', { class: 'card list food-list', 'aria-label': label }, ...list.map(entryRow)));
  }
  if (isToday && state.recent.length) {
    out.push(section('Usuals'));
    out.push(el('div', { class: 'chips food-usuals', role: 'list' }, ...state.recent.map((f) => el('button', {
      class: 'chip', type: 'button', role: 'listitem', text: f.name, 'aria-label': `Add ${f.name}`,
      'on:click': () => addEntry(f),
    }))));
  }
  return out;
}

function bar(fraction, color) {
  const pct = Math.max(0, Math.min(1, fraction || 0)) * 100;
  return el('div', { class: 'food-bar' }, el('div', { class: 'food-bar-fill', style: { width: `${pct}%`, background: color } }));
}

function macroLine(e) {
  const parts = [];
  if (e.protein != null) parts.push(`P ${n0(e.protein)}`);
  if (e.carbs != null) parts.push(`C ${n0(e.carbs)}`);
  if (e.fat != null) parts.push(`F ${n0(e.fat)}`);
  return parts.join(' · ');
}

function entryRow(e) {
  return el('li', { class: 'food-item' },
    el('button', { class: 'food-row', type: 'button', 'aria-label': `Edit ${e.name}`, 'on:click': () => editEntry(e) },
      el('span', { class: 'food-row-main' },
        el('span', { class: 'food-name', text: e.name }),
        el('span', { class: 'food-sub', text: macroLine(e) })),
      el('span', { class: 'food-kcal', text: n0(e.calories) })));
}

function renderHistory() {
  if (!state.days) return [el('div', { class: 'card food-summary food-loading' })];
  const days = state.days;
  if (!days.length) return [emptyState('Nothing logged in the last 30 days.')];
  const avg = (k) => days.reduce((s, d) => s + d[k], 0) / days.length;
  const goal = state.goals.calories;

  // 30 columns, today rightmost; empty days stay as gaps.
  const byDate = new Map(days.map((d) => [d.date, d]));
  const span = [];
  for (let i = 29; i >= 0; i -= 1) span.push(shift(todayKey(), -i));
  const max = Math.max(goal || 0, ...days.map((d) => d.calories)) || 1;
  const chart = el('div', { class: 'food-chart', role: 'img', 'aria-label': 'Calories per day, last 30 days' },
    goal ? el('div', { class: 'food-chart-goal', style: { bottom: `${(goal / max) * 100}%` } }) : null,
    ...span.map((date) => {
      const d = byDate.get(date);
      const h = d ? Math.max(2, (d.calories / max) * 100) : 0;
      return el('button', { class: 'food-col', type: 'button', 'aria-label': `${date}: ${d ? n0(d.calories) : 0} cal`, 'on:click': () => go(date) },
        el('span', { class: 'food-col-fill', style: { height: `${h}%`, background: goal && d && d.calories > goal ? 'var(--red)' : 'var(--accent)' } }));
    }));

  const stats = el('div', { class: 'card food-stats' },
    el('div', { class: 'kv' }, el('span', { class: 'k', text: 'Average calories' }), el('span', { class: 'v', text: n0(avg('calories')) })),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: 'Average protein' }), el('span', { class: 'v', text: `${n0(avg('protein'))} g` })),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: 'Days logged' }), el('span', { class: 'v', text: `${days.length} of 30` })));

  const list = el('ul', { class: 'card list food-list' }, ...days.slice().reverse().map((d) => el('li', { class: 'food-item' },
    el('button', { class: 'food-row', type: 'button', 'on:click': () => go(d.date) },
      el('span', { class: 'food-row-main' },
        el('span', { class: 'food-name', text: dayTitle(d.date) }),
        el('span', { class: 'food-sub', text: `P ${n0(d.protein)} · C ${n0(d.carbs)} · F ${n0(d.fat)}` })),
      el('span', { class: 'food-kcal', text: n0(d.calories) })))));

  return [el('div', { class: 'card food-chart-card' }, chart), stats, section('Days'), list];
}

// ---------------------------------------------------------------- edits

function guessMeal() {
  const h = new Date().getHours();
  if (h < 11) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h >= 17 && h < 22) return 'dinner';
  return 'snack';
}

function fields(e = {}) {
  return [
    { key: 'name', label: 'Food', value: e.name || '', required: true, placeholder: 'e.g. 4 eggs' },
    { key: 'meal', label: 'Meal', type: 'select', value: e.meal || guessMeal(), options: MEALS.map(([value, label]) => ({ value, label })) },
    { key: 'calories', label: 'Calories', type: 'number', value: e.calories ?? '', required: true },
    { key: 'protein', label: 'Protein (g)', type: 'number', value: e.protein ?? '' },
    { key: 'carbs', label: 'Carbs (g)', type: 'number', value: e.carbs ?? '' },
    { key: 'fat', label: 'Fat (g)', type: 'number', value: e.fat ?? '' },
    { key: 'date', label: 'Date', type: 'date', value: e.date || state.date },
    { key: 'notes', label: 'Notes', type: 'textarea', value: e.notes || '' },
  ];
}

function failure(verb, err) {
  if (err && err.status) return `Couldn't ${verb}: ${err.message}`;
  return `Couldn't ${verb} — the PC is unreachable`;
}

async function addEntry(template) {
  if (!state) return;
  const base = template ? { ...template, meal: guessMeal(), date: state.date, notes: '' } : {};
  const values = await formSheet({ title: 'Add food', saveLabel: 'Add', fields: fields(base) });
  if (!values || values === 'delete' || !state) return;
  try {
    await api('/api/food/entries', { method: 'POST', body: values });
    haptic('success');
    state.recent = []; // re-rank usuals
    refresh();
  } catch (err) {
    toast(failure('add', err), { kind: 'error' });
    haptic('error');
  }
}

async function editEntry(e) {
  const values = await formSheet({ title: 'Edit food', canDelete: true, fields: fields(e) });
  if (!values || !state) return;
  try {
    if (values === 'delete') {
      const ok = await kit.confirmSheet({ title: `Delete ${e.name}?`, confirmLabel: 'Delete', destructive: true });
      if (!ok) return;
      await api(`/api/food/entries/${e.id}`, { method: 'DELETE' });
    } else {
      await api(`/api/food/entries/${e.id}`, { method: 'PATCH', body: values });
    }
    haptic('light');
    refresh();
  } catch (err) {
    toast(failure(values === 'delete' ? 'delete' : 'save', err), { kind: 'error' });
    haptic('error');
    refresh();
  }
}

async function editGoals() {
  if (!state) return;
  const g = state.goals || {};
  const values = await formSheet({
    title: 'Daily goals',
    fields: [
      { key: 'calories', label: 'Calories', type: 'number', value: g.calories ?? '', placeholder: 'e.g. 2400' },
      { key: 'protein', label: 'Protein (g)', type: 'number', value: g.protein ?? '', placeholder: 'e.g. 180' },
      { key: 'carbs', label: 'Carbs (g)', type: 'number', value: g.carbs ?? '' },
      { key: 'fat', label: 'Fat (g)', type: 'number', value: g.fat ?? '' },
    ],
  });
  if (!values || values === 'delete' || !state) return;
  try {
    const data = await api('/api/food/goals', { method: 'PUT', body: values });
    state.goals = data.goals;
    haptic('success');
    refresh();
  } catch (err) {
    toast(failure('save', err), { kind: 'error' });
  }
}
