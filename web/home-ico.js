// home-ico.js — ICO's top of the home screen, black & champagne: a serif greeting, the day's
// brief as an editorial list (Today) and the first Ideas. Kept out of launcher.js so upstream
// merges stay small: the launcher only calls renderIcoHome() on render and refreshIcoHome()
// with its badge refresh.
import { api, el, nav, haptic } from './kit.js';
import { IDEAS, ideaRow, arrow } from './ideas.js';

const HOME_IDEAS = 4;
const TODAY_ITEMS = 3;
const ROMAN = ['I', 'II', 'III', 'IV', 'V'];
let todayBody = null;
let todayCount = null;
let inflight = false;

export function renderIcoHome(host) {
  if (!host) return;
  todayCount = el('span', { class: 'lx-count' });
  todayBody = el('button', { class: 'lx-today', type: 'button', 'on:click': () => { haptic('light'); nav.go('#/today'); } });
  const now = new Date();
  host.replaceChildren(
    el('header', { class: 'lx-hero' },
      el('h1', { class: 'lx-greeting' }, greeting(now), el('span', { class: 'lx-dot', text: '.' })),
      el('p', { class: 'lx-date', text: now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) }),
      el('span', { class: 'lx-rule', 'aria-hidden': 'true' })),
    el('section', { class: 'lx-section', 'aria-labelledby': 'lx-today-h' },
      el('div', { class: 'lx-head' }, el('h2', { id: 'lx-today-h', text: 'Aujourd’hui' }), todayCount),
      todayBody),
    el('section', { class: 'lx-section', 'aria-labelledby': 'lx-ideas-h' },
      el('div', { class: 'lx-head' }, el('h2', { id: 'lx-ideas-h', text: 'Idées' })),
      el('ul', { class: 'lx-list' }, ...IDEAS.slice(0, HOME_IDEAS).map((idea, i) => ideaRow(idea, i))),
      el('button', { class: 'lx-all', type: 'button', 'on:click': () => nav.go('#/ideas') },
        el('span', { text: `Toutes les idées (${IDEAS.length})` }), arrow())),
  );
  paintToday(null);
  refreshIcoHome();
}

export function refreshIcoHome() {
  if (!todayBody || inflight) return;
  inflight = true;
  api('/api/today', { timeout: 5000 })
    .then(paintToday)
    .catch(() => {})
    .finally(() => { inflight = false; });
}

function greeting(now) {
  const h = now.getHours();
  if (h < 5) return 'Bonne nuit';
  if (h < 12) return 'Bonjour';
  if (h < 18) return 'Bon après-midi';
  return 'Bonsoir';
}

function paintToday(data) {
  if (!todayBody) return;
  const brief = data && data.brief;
  const items = brief && Array.isArray(brief.items) ? brief.items : [];
  const open = items.filter((it) => !it.done);
  todayCount.textContent = open.length ? `${open.length} en cours` : '';
  const headline = (brief && brief.headline) || (open.length ? 'Ce qui vous attend' : 'Rien d’urgent aujourd’hui.');
  todayBody.replaceChildren(
    el('span', { class: 'lx-headline', text: headline }),
    open.length
      ? el('ol', { class: 'lx-brief' }, ...open.slice(0, TODAY_ITEMS).map((it, i) =>
        el('li', {}, el('span', { class: 'lx-roman', text: ROMAN[i] }), el('span', { class: 'lx-brief-text', text: it.text }))))
      : null,
  );
  todayBody.setAttribute('aria-label', `Today : ${headline}`);
}
