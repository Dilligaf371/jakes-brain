// Today app: ICO's daily cockpit. The date + headline at top, the brief items as a checkable
// list (optimistic PATCH by index, like tasks), then a small summary strip aggregated live from
// the other apps (calories vs goal, open tasks). Data: /api/today.
import * as kit from '../../kit.js';

const { api, el, toast, haptic, navbar, section, emptyState, icon, fmt } = kit;

let state = null;
let els = null;
let listeners = [];

export default {
  mount(root) {
    state = { date: null, brief: null, summary: {}, loaded: false, inflight: false };

    const header = el('div', { class: 'today-header' });
    const list = el('ul', { class: 'card list today-items', 'aria-label': 'Today' });
    const empty = emptyState('No brief yet — ICO will post one.');
    empty.hidden = true;
    const summaryTitle = section('Summary');
    summaryTitle.hidden = true;
    const summary = el('div', { class: 'today-summary' });

    root.append(
      navbar({ title: 'Today' }),
      el('div', { class: 'app-content' }, header, list, empty, summaryTitle, summary),
    );
    els = { header, list, empty, summaryTitle, summary };

    load();
    listen(window, 'jakesdata:online', load);
    listen(window, 'jakesdata:foreground', load);
    listen(document, 'visibilitychange', () => { if (!document.hidden) load(); });
  },

  unmount() {
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners = [];
    state = null;
    els = null;
  },
};

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  listeners.push([target, type, fn]);
}

async function load() {
  if (!state || state.inflight) return;
  state.inflight = true;
  try {
    const data = await api('/api/today');
    if (!state) return;
    state.date = data.date || null;
    state.brief = data.brief && Array.isArray(data.brief.items) ? data.brief : null;
    state.summary = data.summary && typeof data.summary === 'object' ? data.summary : {};
    state.loaded = true;
    render();
  } catch {
    /* keep whatever is on screen; the offline banner reports the outage */
  } finally {
    if (state) state.inflight = false;
  }
}

function render() {
  if (!state || !els) return;
  renderHeader();

  const items = state.brief ? state.brief.items : [];
  els.list.replaceChildren(...items.map(itemRow));
  els.list.hidden = items.length === 0;
  els.empty.hidden = !(state.loaded && !state.brief);

  renderSummary();
}

function renderHeader() {
  const children = [];
  if (state.date) {
    // Parse at local noon so the weekday never slips a day across time zones.
    const d = new Date(`${state.date}T12:00:00`);
    children.push(el('div', { class: 'today-date', text: fmt.date(d, { weekday: true, month: true, day: true }) }));
  }
  if (state.brief && state.brief.headline) {
    children.push(el('div', { class: 'today-headline', text: state.brief.headline }));
  }
  els.header.replaceChildren(...children);
}

function itemRow(item) {
  const check = el('button', {
    class: 'check',
    type: 'button',
    role: 'checkbox',
    'aria-checked': String(Boolean(item.done)),
    'aria-label': item.done ? 'Mark as not done' : 'Mark as done',
    'on:click': () => toggleItem(item.id),
  }, icon('check', { size: 14, strokeWidth: 2.6 }));
  const text = el('span', { class: 'text', text: item.text });
  const row = el('li', { class: item.done ? 'today-item done' : 'today-item', dataset: { id: item.id } }, check, text);
  if (item.kind) row.append(el('span', { class: 'kind', dataset: { kind: item.kind }, text: item.kind }));
  return row;
}

async function toggleItem(index) {
  if (!state || !state.brief) return;
  const item = state.brief.items[index];
  if (!item) return;
  const next = !item.done;
  haptic('light');
  setDoneLocal(index, next);
  render();
  try {
    const data = await api(`/api/today/items/${index}`, { method: 'PATCH', body: { done: next } });
    if (!state) return;
    if (data.brief && Array.isArray(data.brief.items)) {
      state.brief = data.brief;
      render();
    }
  } catch (err) {
    if (!state) return;
    if (err && err.status === 404) {
      load(); // the brief changed under us — reload the truth
    } else {
      setDoneLocal(index, !next);
      render();
      toast(err && err.status ? `Couldn't update: ${err.message}` : "Couldn't update — the PC is unreachable", { kind: 'error' });
      haptic('error');
    }
  }
}

function setDoneLocal(index, done) {
  if (!state || !state.brief) return;
  state.brief = { ...state.brief, items: state.brief.items.map((it, i) => (i === index ? { ...it, done } : it)) };
}

function renderSummary() {
  const cards = [];
  const food = state.summary && state.summary.food;
  if (food) {
    const value = food.goalCalories != null
      ? `${fmtNum(food.calories)} / ${fmtNum(food.goalCalories)}`
      : fmtNum(food.calories);
    cards.push(summaryCard('Calories', value, 'cal'));
  }
  if (typeof state.summary.openTasks === 'number') {
    cards.push(summaryCard('Open tasks', fmtNum(state.summary.openTasks), state.summary.openTasks === 1 ? 'task' : 'tasks'));
  }
  els.summary.replaceChildren(...cards);
  const show = state.loaded && cards.length > 0;
  els.summary.hidden = !show;
  els.summaryTitle.hidden = !show;
}

function summaryCard(label, value, unit) {
  return el('div', { class: 'today-card' },
    el('div', { class: 'today-card-value' }, el('span', { class: 'n', text: value }), el('span', { class: 'u', text: unit })),
    el('div', { class: 'today-card-label', text: label }));
}

function fmtNum(n) {
  return Number(n) % 1 === 0 ? String(Number(n)) : String(Math.round(Number(n) * 10) / 10);
}
