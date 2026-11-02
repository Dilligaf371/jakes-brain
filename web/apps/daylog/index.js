// Day Log: what was said each day, from the auto-vlog transcripts. Read-only.
import * as kit from '../../kit.js';

const { api, el, fmt, toast, navbar, emptyState, debounce, nav } = kit;
const when = (minute) => {
  const h = Math.floor(minute / 60);
  return `${h % 12 || 12}:${String(minute % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const nice = (date) => fmt.date(`${date}T12:00:00`, { weekday: 'long', month: 'short', day: 'numeric' });
let root; let live = false; let q = ''; let body = null;

async function drawDays() {
  const { days } = await api('/api/daylog/days', { timeout: 20000 });
  if (!live || !body?.isConnected) return;
  body.replaceChildren(...(days.length ? [el('div', { class: 'card' }, days.map((d) =>
    el('button', { class: 'row tappable', type: 'button', 'on:click': () => nav.go(`#/daylog/${d.date}`) },
      el('span', { class: 'label' }, el('span', { class: 'name', text: nice(d.date) }), el('span', { class: 'sub', text: `${when(d.first)} to ${when(d.last)} · ${d.words.toLocaleString()} words` })))))] : [emptyState('No transcripts yet. They appear after the auto-vlog runs.')]));
}
async function drawHits() {
  const { hits } = await api(`/api/daylog/search?q=${encodeURIComponent(q)}`, { timeout: 20000 });
  if (!live || !body?.isConnected) return;
  body.replaceChildren(...(hits.length ? [el('div', { class: 'card' }, hits.map((h) =>
    el('button', { class: 'row tappable', type: 'button', 'on:click': () => nav.go(`#/daylog/${h.date}`) },
      el('span', { class: 'label' }, el('span', { class: 'sub', text: `${nice(h.date)} · ${when(h.minute)}` }), el('span', { class: 'snippet', text: h.snippet })))))] : [emptyState('Nothing matches.')]));
}
const fail = (err) => toast(err.message, { kind: 'error' });
function list() {
  const search = debounce(() => (q ? drawHits() : drawDays()).catch(fail), 300);
  body = el('div');
  root.replaceChildren(navbar({ title: 'Day Log' }), el('div', { class: 'app-content' },
    el('input', { class: 'input find', type: 'search', placeholder: 'Search what you said', value: q, 'aria-label': 'Search transcripts', 'on:input': (e) => { q = e.target.value.trim(); search(); } }), body));
  (q ? drawHits() : drawDays()).catch(fail);
}
async function day(date) {
  try {
    const log = await api(`/api/daylog/days/${date}`, { timeout: 20000 });
    if (!live) return;
    root.replaceChildren(navbar({ title: fmt.date(`${date}T12:00:00`, { month: 'short', day: 'numeric' }), back: true }),
      el('div', { class: 'app-content' },
        log.video_id ? el('button', { class: 'button watch', type: 'button', text: 'Watch this vlog', 'on:click': () => nav.go(`#/jaketube/watch/${log.video_id}`) }) : null,
        log.blocks.map((b) => el('div', { class: 'block' }, el('div', { class: 'time', text: when(b.minute) }), el('div', { class: 'said', text: b.text })))));
  } catch (err) { fail(err); }
}
const show = (sub) => (/^\d{4}-\d{2}-\d{2}$/.test(sub || '') ? day(sub) : list());
export default {
  mount(el_, ctx) { root = el_; live = true; q = ''; root.append(navbar({ title: 'Day Log' })); show(ctx.sub); },
  route(sub) { show(sub); },
  unmount() { live = false; root = null; body = null; },
};
