// Bots: read-only status of the Zora bot and the feed accounts. There are no controls here on
// purpose: the Zora bot trades real money.
import * as kit from '../../kit.js';

const { api, el, fmt, toast, navbar, section, emptyState } = kit;
const REFRESH_MS = 30_000;
const usd = (n) => `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(2)}`;
let root; let timer = null;

function render({ zora, feed }) {
  const real = zora?.books.filter((b) => b.real_money) || [];
  const row = (b) => el('div', { class: 'row' },
    el('span', { class: 'label' }, el('span', { class: 'name', text: b.what || b.id }), el('span', { class: 'sub', text: `${b.id} · ${b.wins} of ${b.closed} won${b.open ? ` · ${b.open} open` : ''}` })),
    el('span', { class: `right ${b.pnl_total < 0 ? 'down' : 'up'}`, text: usd(b.pnl_total) }));
  const accounts = feed?.accounts || [];
  root.replaceChildren(navbar({ title: 'Bots' }), el('div', { class: 'app-content' },
    section('Zora'),
    zora ? el('p', { class: 'muted note', text: `${zora.mode === 'live' ? 'Trading real money' : `Mode: ${zora.mode}`}${zora.updated ? ` · updated ${fmt.relTime(zora.updated)}` : ''}` }) : emptyState('Zora bot status not found.'),
    real.length ? el('div', { class: 'card' }, real.map(row)) : null,
    zora ? section('Paper books') : null,
    zora ? el('div', { class: 'card' }, zora.books.filter((b) => !b.real_money).map(row)) : null,
    section(`Feed accounts${feed && !feed.live ? ' · paused' : ''}`),
    accounts.length ? el('div', { class: 'card' }, accounts.map((a) => {
      const empty = a.queued === 0;
      return el('div', { class: 'row' },
        el('span', { class: `dot ${!a.enabled ? 'off' : empty ? 'warn' : 'on'}` }),
        el('span', { class: 'label' }, el('span', { class: 'name', text: a.name }), el('span', { class: 'sub', text: `${a.platform}${a.last_post ? ` · posted ${fmt.relTime(a.last_post)}` : ' · no posts yet'}` })),
        el('span', { class: `right${empty ? ' down' : ''}`, text: a.queued === null ? 'auto' : `${a.queued} left` }));
    })) : emptyState('Feed accounts not found.')));
}
async function refresh() {
  try {
    const status = await api('/api/bots/status', { timeout: 15000 });
    if (root) render(status);
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}
export default {
  mount(el_) { root = el_; root.append(navbar({ title: 'Bots' })); refresh(); timer = setInterval(refresh, REFRESH_MS); },
  unmount() { clearInterval(timer); timer = null; root = null; },
};
