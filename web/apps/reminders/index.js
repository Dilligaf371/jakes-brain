// Reminders: on the iPhone these pop up as notifications, scheduled by the native shell.
import * as kit from '../../kit.js';

const { api, el, fmt, toast, haptic, navbar, section, emptyState, confirmSheet, icon, holdReload, releaseReload } = kit;
const HOLD = 'reminders:typing';
const QUICK = [['1 min', 1], ['10 min', 10], ['1 hour', 60]];
let root; let reminders = []; let device = null; let timer = null; let due = null; let title = '';

const syncPhone = () => window.webkit?.messageHandlers?.native?.postMessage({ type: 'reminders', action: 'sync' });
const pad = (n) => String(n).padStart(2, '0');
const toLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const inMinutes = (m) => new Date(Date.now() + m * 60_000);
function tomorrowNine() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}
async function refresh() {
  try {
    ({ reminders, device } = await api('/api/reminders'));
    if (root) render();
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}
async function change(call) {
  try {
    await call();
    syncPhone();
    await refresh();
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}
function row(item) {
  const late = !item.done && new Date(item.due_at) <= new Date();
  return el('div', { class: `row${item.done ? ' done' : ''}` },
    el('button', { class: `check${item.done ? ' on' : ''}`, type: 'button', 'aria-label': item.done ? 'Mark not done' : 'Mark done', 'on:click': () => {
      haptic('light');
      change(() => api(`/api/reminders/${item.id}`, { method: 'PATCH', body: { done: !item.done } }));
    } }, item.done ? icon('check', { size: 18 }) : null),
    el('span', { class: 'label' }, el('span', { class: 'what', text: item.title }),
      el('span', { class: `sub${late ? ' late' : ''}`, text: item.waiting_for_allow ? 'Starts when you allow notifications' : fmt.date(item.due_at, { weekday: 'short', month: 'short', day: 'numeric', time: true }) })),
    el('button', { class: 'del', type: 'button', 'aria-label': 'Delete reminder', 'on:click': async () => {
      if (await confirmSheet({ title: 'Delete this reminder?', message: item.title, confirmLabel: 'Delete', destructive: true })) {
        change(() => api(`/api/reminders/${item.id}`, { method: 'DELETE' }));
      }
    } }, icon('trash', { size: 20 })));
}
function render() {
  if (!root) return;
  const name = el('input', { class: 'input', type: 'text', maxlength: '200', placeholder: 'Remind me to…', value: title, 'aria-label': 'Reminder', 'on:input': (e) => { title = e.target.value; }, 'on:focus': () => holdReload(HOLD), 'on:blur': () => releaseReload(HOLD) });
  const at = el('input', { class: 'input', type: 'datetime-local', 'aria-label': 'When', value: toLocal(due), 'on:change': (e) => { if (e.target.value) due = new Date(e.target.value); } });
  const add = async (event) => {
    event.preventDefault();
    const text = name.value.trim();
    if (!text) return;
    if (due <= new Date()) { toast('Pick a time in the future', { kind: 'error' }); return; }
    title = '';
    haptic('success');
    await change(() => api('/api/reminders', { method: 'POST', body: { title: text, due_at: due.toISOString() } }));
    due = inMinutes(60);
    render();
  };
  const chips = el('div', { class: 'chips' }, QUICK.map(([label, m]) => el('button', { class: 'chip', type: 'button', text: label, 'on:click': () => { title = name.value; due = inMinutes(m); render(); } })),
    el('button', { class: 'chip', type: 'button', text: 'Tomorrow 9 AM', 'on:click': () => { title = name.value; due = tomorrowNine(); render(); } }));
  const open = reminders.filter((item) => !item.done);
  const done = reminders.filter((item) => item.done).slice(0, 20);
  const denied = device?.status === 'denied';
  root.replaceChildren(navbar({ title: 'Reminders' }), el('div', { class: 'app-content' },
    denied ? el('p', { class: 'warn', text: 'Notifications are off. Turn them on in iPhone Settings, under Jake\'s Brain.' }) : null,
    el('form', { class: 'card compose', autocomplete: 'off', 'on:submit': add }, name, chips, at, el('button', { class: 'button add', type: 'submit', text: 'Add reminder' })),
    open.length ? section('Upcoming') : null,
    open.length ? el('div', { class: 'card' }, open.map(row)) : emptyState('No reminders yet.'),
    done.length ? section('Done') : null,
    done.length ? el('div', { class: 'card' }, done.map(row)) : null));
}
export default {
  mount(el_) {
    root = el_;
    due = inMinutes(60);
    title = '';
    root.append(navbar({ title: 'Reminders' }));
    refresh();
    timer = setInterval(() => { if (!document.activeElement || document.activeElement === document.body) refresh(); }, 30_000);
  },
  unmount() { clearInterval(timer); timer = null; root = null; releaseReload(HOLD); },
};
