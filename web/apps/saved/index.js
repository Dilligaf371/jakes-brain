// Saved: paste a link, the PC stores the page text, read and search it later.
import * as kit from '../../kit.js';

const { api, el, fmt, toast, haptic, navbar, navButton, emptyState, confirmSheet, debounce, nav, holdReload, releaseReload } = kit;
const HOLD = 'saved:typing';
let root; let live = false; let q = ''; let links = []; let listEl = null;

function drawList() {
  listEl.replaceChildren(...(links.length ? [el('div', { class: 'card' }, links.map((link) =>
    el('button', { class: `row tappable${link.is_read ? ' read' : ''}`, type: 'button', 'on:click': () => nav.go(`#/saved/${link.id}`) },
      el('span', { class: 'label' }, el('span', { class: 'name', text: link.title }), el('span', { class: 'sub', text: `${link.site} · ${fmt.relTime(link.created_at)}` })))))] : [emptyState(q ? 'Nothing matches.' : 'Paste a link above to save it.')]));
}
async function refresh() {
  ({ links } = await api(`/api/saved${q ? `?q=${encodeURIComponent(q)}` : ''}`));
  if (live && listEl?.isConnected) drawList();
}
async function add(url, button) {
  button.disabled = true;
  try {
    const out = await api('/api/saved', { method: 'POST', body: { url }, timeout: 40000 });
    haptic('success');
    if (out.existing) toast('Already saved');
    else if (out.link.fetch_error) toast(`Saved the link, but no text: ${out.link.fetch_error}`, { ms: 3500 });
    await refresh();
    return true;
  } catch (err) {
    toast(err.message, { kind: 'error' });
    return false;
  } finally {
    button.disabled = false;
  }
}
function list() {
  const input = el('input', { class: 'input', type: 'url', inputmode: 'url', autocapitalize: 'off', autocorrect: 'off', placeholder: 'Paste a link', 'aria-label': 'Link to save', name: 'url', 'on:focus': () => holdReload(HOLD), 'on:blur': () => releaseReload(HOLD) });
  const button = el('button', { class: 'button add', type: 'submit', text: 'Save' });
  const form = el('form', { class: 'add-form', 'on:submit': async (event) => {
    event.preventDefault();
    const url = input.value.trim();
    if (url && await add(url, button)) input.value = '';
  } }, input, button);
  const search = debounce(() => refresh().catch(() => {}), 300);
  const find = el('input', { class: 'input find', type: 'search', placeholder: 'Search saved pages', value: q, 'aria-label': 'Search saved pages', 'on:input': (e) => { q = e.target.value.trim(); search(); } });
  listEl = el('div');
  root.replaceChildren(navbar({ title: 'Saved' }), el('div', { class: 'app-content' }, form, find, listEl));
  drawList();
}
async function reader(id) {
  try {
    const { link } = await api(`/api/saved/${id}`);
    if (!live) return;
    if (!link.is_read) api(`/api/saved/${id}`, { method: 'PATCH', body: { is_read: true } }).catch(() => {});
    const remove = async () => {
      if (!await confirmSheet({ title: 'Delete this link?', message: link.title, confirmLabel: 'Delete', destructive: true })) return;
      await api(`/api/saved/${id}`, { method: 'DELETE' }).catch((err) => toast(err.message, { kind: 'error' }));
      nav.back();
    };
    root.replaceChildren(
      navbar({ title: link.site, back: true, right: [navButton({ label: 'Delete', icon: 'trash', onClick: remove })] }),
      el('div', { class: 'app-content reader' },
        el('h2', { text: link.title }),
        el('a', { class: 'open', href: link.url, target: '_blank', rel: 'noopener', text: 'Open original' }),
        link.content ? el('div', { class: 'text', text: link.content }) : emptyState(link.fetch_error ? `No text saved: ${link.fetch_error}.` : 'No text saved.')));
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}
const show = (sub) => (/^\d+$/.test(sub || '') ? reader(sub) : refresh().then(list).catch((err) => toast(err.message, { kind: 'error' })));
export default {
  mount(el_, ctx) { root = el_; live = true; q = ''; root.append(navbar({ title: 'Saved' })); show(ctx.sub); },
  route(sub) { show(sub); },
  unmount() { live = false; root = null; listEl = null; releaseReload(HOLD); },
};
