// People: a simple contact list. Each person's @handle links them in the Graph.
import * as kit from '../../kit.js';
import { formSheet } from '../../form.js';

const { api, el, toast, haptic, navbar, navButton, emptyState, confirmSheet, debounce, nav, section } = kit;
let root; let people = []; let q = ''; let live = false; let listEl = null;

const fields = (p = {}) => [
  { key: 'name', label: 'Name', value: p.name, required: true },
  ...(p.id ? [{ key: 'handle', label: 'Handle (use @handle anywhere to link them)', value: p.handle, required: true }] : []),
  { key: 'role', label: 'Who they are', value: p.role, placeholder: 'Brand rep at Gamma' },
  { key: 'contact', label: 'Email, phone, or link', value: p.contact },
  { key: 'notes', label: 'Notes', type: 'textarea', value: p.notes },
];
async function edit(person) {
  const result = await formSheet({ title: person ? person.name : 'New person', fields: fields(person), canDelete: Boolean(person) });
  if (!result) return;
  try {
    if (result === 'delete') {
      if (!await confirmSheet({ title: 'Delete this person?', message: person.name, confirmLabel: 'Delete', destructive: true })) return;
      await api(`/api/people/${person.id}`, { method: 'DELETE' });
      nav.go('#/people');
    } else if (person) {
      await api(`/api/people/${person.id}`, { method: 'PATCH', body: result });
      detail(person.id);
    } else {
      await api('/api/people', { method: 'POST', body: result });
    }
    haptic('success');
    await refresh();
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}
async function refresh() {
  ({ people } = await api(`/api/people${q ? `?q=${encodeURIComponent(q)}` : ''}`));
  if (live && listEl?.isConnected) drawList();
}
function drawList() {
  listEl.replaceChildren(...(people.length ? [el('div', { class: 'card' }, people.map((p) =>
    el('button', { class: 'row tappable', type: 'button', 'on:click': () => nav.go(`#/people/${p.id}`) },
      el('span', { class: 'label' }, el('span', { class: 'who', text: p.name }), p.role ? el('span', { class: 'sub', text: p.role }) : null),
      el('span', { class: 'right', text: `@${p.handle}` }))))] : [emptyState(q ? 'Nobody matches.' : 'No people yet. Tap + to add someone.')]));
}
function list() {
  const search = debounce(() => refresh().catch(() => {}), 250);
  const input = el('input', { class: 'input find', type: 'search', placeholder: 'Search', value: q, 'aria-label': 'Search people', 'on:input': (e) => { q = e.target.value.trim(); search(); } });
  listEl = el('div', { class: 'people-list' });
  root.replaceChildren(navbar({ title: 'People', right: [navButton({ label: 'New person', icon: 'plus', onClick: () => edit() })] }), el('div', { class: 'app-content' }, input, listEl));
  drawList();
}
async function detail(id) {
  try {
    const { person: p } = await api(`/api/people/${id}`);
    if (!live) return;
    const kv = (k, v) => (v ? el('div', { class: 'kv' }, el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v })) : null);
    root.replaceChildren(
      navbar({ title: p.name, back: true, right: [navButton({ label: 'Edit', icon: 'edit', onClick: () => edit(p) })] }),
      el('div', { class: 'app-content' },
        el('div', { class: 'card' }, kv('Handle', `@${p.handle}`), kv('Role', p.role), kv('Contact', p.contact)),
        p.notes ? section('Notes') : null, p.notes ? el('div', { class: 'card body', text: p.notes }) : null,
        el('button', { class: 'button graph', type: 'button', text: 'See in Graph', 'on:click': () => nav.go(`#/graph/person:${p.id}`) })));
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}
const show = (sub) => (/^\d+$/.test(sub || '') ? detail(sub) : refresh().then(list).catch((err) => toast(err.message, { kind: 'error' })));
export default {
  mount(el_, ctx) { root = el_; live = true; q = ''; root.append(navbar({ title: 'People' })); show(ctx.sub); },
  route(sub) { show(sub); },
  unmount() { live = false; root = null; listEl = null; },
};
