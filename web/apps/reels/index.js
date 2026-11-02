// Reels: proposed reels, hook ideas, and top performers from the tracker on the PC. Read-only,
// except "Save to Notes", which writes to this app's own Notes.
import * as kit from '../../kit.js';

const { api, el, fmt, toast, haptic, navbar, emptyState, nav } = kit;
const TABS = [['ideas', 'Ideas', '/api/reels/proposals'], ['hooks', 'Hooks', '/api/reels/hooks'], ['top', 'Top', '/api/reels/top']];
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

let root; let tab = 'ideas'; let data = {};

async function load(id) {
  if (data[id]) return data[id];
  const { items } = await api(TABS.find((t) => t[0] === id)[2], { timeout: 15000 });
  data[id] = items;
  return items;
}
async function saveNote(idea) {
  try {
    await api('/api/notes', { method: 'POST', body: { title: idea.title, body: `${idea.hook}\n\n${idea.script || ''}\n\nCaption: ${idea.caption || ''}`.trim() } });
    haptic('success');
    toast('Saved to Notes');
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}
function ideaRow(idea) {
  return el('button', { class: 'card idea', type: 'button', 'on:click': () => nav.go(`#/reels/idea/${idea.id}`) },
    el('span', { class: 'meta', text: `${idea.source || 'idea'} · ${fmt.date(`${idea.batch_date}T12:00:00`, { month: 'short', day: 'numeric' })}` }),
    el('strong', { text: idea.title }), el('span', { class: 'muted', text: idea.hook }));
}
function hookRow(hook) {
  return el('div', { class: 'card idea' }, el('span', { class: 'meta', text: hook.maker }), el('strong', { text: hook.hook }), el('span', { class: 'muted', text: hook.reason || '' }));
}
function topRow(reel, index) {
  return el('a', { class: 'card idea', href: reel.url, target: '_blank', rel: 'noopener' },
    el('span', { class: 'meta', text: `#${index + 1} · ${reel.posted_at ? fmt.date(reel.posted_at, { month: 'short', day: 'numeric', year: 'numeric' }) : ''}` }),
    el('strong', { text: `${compact(reel.views)} views${reel.median ? ` · ${(reel.views / reel.median).toFixed(1)}x usual` : ''}` }),
    el('span', { class: 'muted clamp', text: reel.caption.split('\n')[0] }));
}
async function renderList() {
  root.replaceChildren(navbar({ title: 'Reels' }));
  const content = el('div', { class: 'app-content' });
  const seg = el('div', { class: 'segmented', role: 'group' }, TABS.map(([id, label]) =>
    el('button', { type: 'button', text: label, class: id === tab ? 'active selected' : '', 'aria-pressed': String(id === tab), 'on:click': () => { tab = id; renderList(); } })));
  const list = el('div', { class: 'stack' }, el('p', { class: 'muted center', text: 'Loading…' }));
  content.append(seg, list);
  root.append(content);
  const showing = tab;
  try {
    const items = await load(showing);
    if (showing !== tab || !list.isConnected) return;
    const row = showing === 'ideas' ? ideaRow : showing === 'hooks' ? hookRow : topRow;
    list.replaceChildren(...(items.length ? items.map(row) : [emptyState('Nothing here yet.')]));
  } catch (err) {
    if (list.isConnected) list.replaceChildren(emptyState(err.status === 502 ? "Can't reach the reels tracker." : err.message));
  }
}
async function renderIdea(id) {
  const items = await load('ideas').catch(() => []);
  const idea = items.find((item) => String(item.id) === id);
  root.replaceChildren(navbar({ title: 'Idea', back: true }));
  if (!idea) return root.append(el('div', { class: 'app-content' }, emptyState('That idea is gone.')));
  const block = (label, value) => (value ? [kit.section(label), el('div', { class: 'card body', text: value })] : []);
  root.append(el('div', { class: 'app-content' },
    el('h2', { class: 'title', text: idea.title }), ...block('Hook', idea.hook), ...block('Script', idea.script),
    ...block('On screen', idea.on_screen), ...block('Caption', idea.caption),
    el('button', { class: 'button save', type: 'button', text: 'Save to Notes', 'on:click': () => saveNote(idea) })));
  return undefined;
}
const show = (sub) => {
  const match = /^idea\/(\d+)$/.exec(sub || '');
  return match ? renderIdea(match[1]) : renderList();
};
export default {
  mount(el_, ctx) { root = el_; data = {}; show(ctx.sub); },
  route(sub) { show(sub); },
  unmount() { root = null; },
};
