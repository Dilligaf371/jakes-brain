// Focus: a countdown that logs each finished session. The end time is stored, so the timer
// catches up after the phone sleeps or the page reloads.
import * as kit from '../../kit.js';

const { api, el, fmt, toast, haptic, navbar, section, emptyState, store, holdReload, releaseReload, confirmSheet } = kit;
const KEY = 'focus.running';
const HOLD = 'focus:running';
const PRESETS = [15, 25, 50];
const clock = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const hours = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`);

let root; let timer = null; let minutes = 25; let label = ''; let stats = null;

async function log(run, used) {
  store.del(KEY);
  releaseReload(HOLD);
  clearInterval(timer);
  timer = null;
  if (used >= 1) {
    await api('/api/focus', { method: 'POST', body: { label: run.label, minutes: Math.round(used * 10) / 10, started_at: new Date(run.startedAt).toISOString() } })
      .catch((err) => toast(`Not logged: ${err.message}`, { kind: 'error' }));
  }
}
async function finish(run) {
  haptic('success');
  await log(run, run.minutes);
  toast(`${run.minutes} minutes done`);
  await refresh();
}
async function stop(run) {
  if (!await confirmSheet({ title: 'End this session?', message: 'Time so far is logged if it passed one minute.', confirmLabel: 'End session' })) return;
  await log(run, (Date.now() - run.startedAt) / 60000);
  await refresh();
}
function tick(run, face) {
  const left = run.startedAt + run.minutes * 60000 - Date.now();
  if (left <= 0) { finish(run); return; }
  face.textContent = clock(left);
}
function render() {
  if (!root) return;
  const run = store.get(KEY, null);
  const face = el('div', { class: 'face', text: clock((run ? run.minutes : minutes) * 60000) });
  const top = run
    ? [run.label ? el('p', { class: 'muted center', text: run.label }) : null, face, el('button', { class: 'button go', type: 'button', text: 'End session', 'on:click': () => stop(run) })]
    : [face,
      el('div', { class: 'segmented', role: 'group', 'aria-label': 'Length' }, PRESETS.map((m) =>
        el('button', { type: 'button', text: `${m} min`, class: m === minutes ? 'active selected' : '', 'aria-pressed': String(m === minutes), 'on:click': () => { minutes = m; render(); } }))),
      el('input', { class: 'input what', type: 'text', maxlength: '120', placeholder: 'What are you working on?', value: label, 'aria-label': 'What are you working on?', 'on:input': (e) => { label = e.target.value; } }),
      el('button', { class: 'button go primary', type: 'button', text: 'Start', 'on:click': () => {
        store.set(KEY, { startedAt: Date.now(), minutes, label: label.trim() });
        haptic('medium');
        render();
      } })];
  const max = Math.max(...(stats?.byDay || []).map((d) => d.minutes), 1);
  root.replaceChildren(navbar({ title: 'Focus' }), el('div', { class: 'app-content' }, ...top,
    stats ? section(`This week · ${hours(stats.total)}`) : null,
    stats ? el('div', { class: 'card bars' }, stats.byDay.map((d) => el('div', { class: 'bar-col' },
      el('div', { class: 'bar-track' }, el('div', { class: 'bar-value', style: { height: `${(d.minutes / max) * 100}%` } })),
      el('span', { text: fmt.date(`${d.date}T12:00:00`, { weekday: 'short' }).slice(0, 2) })))) : null,
    stats?.sessions.length ? section('Recent') : null,
    stats?.sessions.length ? el('div', { class: 'card' }, stats.sessions.slice(0, 8).map((s) =>
      el('div', { class: 'row' }, el('span', { class: 'label', text: s.label || 'Focus' }), el('span', { class: 'right', text: `${hours(s.minutes)} · ${fmt.relTime(s.started_at)}` })))) : (stats ? emptyState('No sessions yet this week.') : null)));
  clearInterval(timer);
  timer = null;
  if (run) {
    holdReload(HOLD);
    tick(run, face);
    if (store.get(KEY, null)) timer = setInterval(() => tick(run, face), 1000);
  }
}
async function refresh() {
  stats = await api('/api/focus?days=7').catch(() => stats);
  render();
}
const onForeground = () => render();
export default {
  mount(el_) { root = el_; root.append(navbar({ title: 'Focus' })); render(); refresh(); window.addEventListener('jakesdata:foreground', onForeground); },
  unmount() { clearInterval(timer); timer = null; root = null; releaseReload(HOLD); window.removeEventListener('jakesdata:foreground', onForeground); },
};
