// home-ico.js — ICO's Khalas-style top of the home screen: a greeting, a live Today card and a
// strip of Ideas. Kept out of launcher.js so upstream merges stay small: the launcher only calls
// renderIcoHome() on render and refreshIcoHome() with its badge refresh.
import { api, el, nav, haptic } from './kit.js';
import { IDEAS, ideaIcon, askICO } from './ideas.js';

const STRIP_MAX = 8;
let todayCard = null;
let inflight = false;

export function renderIcoHome(host) {
  if (!host) return;
  todayCard = el('button', { class: 'ico-today', type: 'button', 'aria-label': 'Today', 'on:click': () => { haptic('light'); nav.go('#/today'); } });
  const strip = el('div', { class: 'ico-strip', role: 'list' }, ...IDEAS.slice(0, STRIP_MAX).map(stripItem));
  host.replaceChildren(
    el('h1', { class: 'ico-greeting', text: greeting() }),
    todayCard,
    el('div', { class: 'ico-row-head' },
      el('span', { text: 'Ideas' }),
      el('button', { class: 'ico-more', type: 'button', text: 'Tout voir', 'on:click': () => nav.go('#/ideas') })),
    strip,
  );
  paintToday(null);
  refreshIcoHome();
}

export function refreshIcoHome() {
  if (!todayCard || inflight) return;
  inflight = true;
  api('/api/today', { timeout: 5000 })
    .then(paintToday)
    .catch(() => {})
    .finally(() => { inflight = false; });
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Bonne nuit';
  if (h < 12) return 'Bonjour';
  if (h < 18) return 'Bon après-midi';
  return 'Bonsoir';
}

function paintToday(data) {
  if (!todayCard) return;
  const items = data && data.brief && Array.isArray(data.brief.items) ? data.brief.items : [];
  const open = items.filter((it) => !it.done);
  const headline = (data && data.brief && data.brief.headline)
    || (open.length ? `${open.length} chose${open.length > 1 ? 's' : ''} pour aujourd'hui` : 'Rien d’urgent aujourd’hui');
  const list = el('ul', { class: 'ico-today-items' },
    ...open.slice(0, 3).map((it) => el('li', {}, el('span', { class: 'dot', dataset: { kind: it.kind || '' } }), el('span', { text: it.text }))));
  todayCard.replaceChildren(
    el('span', { class: 'ico-today-kicker', text: 'Today' }),
    el('span', { class: 'ico-today-headline', text: headline }),
    list,
  );
  list.hidden = open.length === 0;
}

function stripItem(idea) {
  return el('button', { class: 'idea-card', type: 'button', role: 'listitem', 'on:click': () => askICO(idea) },
    el('img', { class: 'idea-art', src: ideaIcon(idea), alt: '', loading: 'lazy', draggable: 'false' }),
    el('span', { class: 'idea-title', text: idea.title }));
}
