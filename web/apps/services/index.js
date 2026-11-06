// Services app: UAE life admin that ICO reads from the owner's mail (deliveries, bills, official
// matters), plus a directory of the owner's UAE apps. Data: /api/services. A link opens the
// provider's site; inside the ICO iPhone app the web view hands it to iOS, which opens the
// provider's app when it claims that domain.
import * as kit from '../../kit.js';
import { arrow } from '../../ideas.js';

const { api, el, navbar, toast, haptic } = kit;

const SECTIONS = [
  { kind: 'delivery', title: 'Livraisons', empty: 'Aucune livraison en cours.' },
  { kind: 'bill', title: 'Factures', empty: 'Aucune facture en attente.' },
  { kind: 'official', title: 'Démarches', empty: 'Rien à signaler côté administration.' },
];

// shortcut: https entry points only (no unverified URL schemes); iOS opens the app when it
// claims the domain, Safari otherwise. Upgrade per app once its deep links are confirmed.
const APPS = [
  { name: 'Careem', note: 'Courses, livraison, paiements', url: 'https://www.careem.com/en-ae/' },
  { name: 'noon', note: 'Shopping et courses', url: 'https://www.noon.com/uae-en/' },
  { name: 'Amazon.ae', note: 'Commandes et suivi', url: 'https://www.amazon.ae/gp/css/order-history' },
  { name: 'Deliveroo', note: 'Repas', url: 'https://deliveroo.ae/en/' },
  { name: 'talabat', note: 'Repas et courses', url: 'https://www.talabat.com/uae' },
  { name: 'Instashop', note: 'Courses', url: 'https://instashop.com/' },
  { name: 'Washmen', note: 'Pressing', url: 'https://www.washmen.com/' },
  { name: 'e&', note: 'Factures et forfait', url: 'https://www.eand.ae/en/index.html' },
  { name: 'du', note: 'Factures et forfait', url: 'https://www.du.ae/personal' },
  { name: 'UAE PASS', note: 'Identité numérique', url: 'https://uaepass.ae/' },
  { name: 'ICP', note: 'Visa, Emirates ID', url: 'https://icp.gov.ae/' },
  { name: 'TAMM', note: 'Services d’Abu Dhabi', url: 'https://www.tamm.abudhabi/' },
  { name: 'DEWA', note: 'Eau et électricité', url: 'https://www.dewa.gov.ae/' },
  { name: 'RTA', note: 'Permis, amendes, Salik', url: 'https://www.rta.ae/' },
];

let state = null;
let els = null;
let listeners = [];

export default {
  mount(root) {
    state = { events: [], loaded: false, inflight: false };
    const sections = el('div', { class: 'svc-sections' });
    const apps = el('ul', { class: 'lx-list' }, ...APPS.map(appRow));
    root.append(
      navbar({ title: 'Services' }),
      el('div', { class: 'app-content lx-page' },
        el('p', { class: 'lx-lead', text: 'Ce qu’ICO repère dans vos mails et SMS : livraisons, factures et démarches officielles.' }),
        sections,
        el('section', { class: 'lx-section', 'aria-labelledby': 'svc-apps-h' },
          el('div', { class: 'lx-head' }, el('h2', { id: 'svc-apps-h', text: 'Vos apps' })),
          apps)),
    );
    els = { sections };
    render();
    load();
    listen(window, 'jakesdata:foreground', load);
    listen(document, 'visibilitychange', () => { if (!document.hidden) load(); });
  },
  unmount() {
    for (const [t, type, fn] of listeners) t.removeEventListener(type, fn);
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
    const data = await api('/api/services');
    if (!state) return;
    state.events = Array.isArray(data.events) ? data.events : [];
    state.loaded = true;
    render();
  } catch {
    /* the offline banner reports the outage */
  } finally {
    if (state) state.inflight = false;
  }
}

function render() {
  if (!state || !els) return;
  els.sections.replaceChildren(...SECTIONS.map((s) => {
    const open = state.events.filter((e) => e.kind === s.kind && !e.done);
    return el('section', { class: 'lx-section', 'aria-labelledby': `svc-${s.kind}-h` },
      el('div', { class: 'lx-head' },
        el('h2', { id: `svc-${s.kind}-h`, text: s.title }),
        el('span', { class: 'lx-count', text: open.length ? `${open.length} en cours` : '' })),
      open.length
        ? el('ul', { class: 'lx-list' }, ...open.map(eventRow))
        : el('p', { class: 'svc-empty', text: state.loaded ? s.empty : 'Chargement…' }));
  }));
}

function eventRow(e) {
  const when = e.at ? new Date(e.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';
  return el('li', { class: 'lx-row svc-row' },
    el('div', { class: 'svc-body' },
      el('span', { class: 'lx-row-title svc-title', text: e.title }),
      el('span', { class: 'lx-row-detail', text: [e.provider, when].filter(Boolean).join(' · ') })),
    el('button', { class: 'svc-done', type: 'button', text: 'Fait', 'aria-label': `Marquer « ${e.title} » comme fait`, 'on:click': () => markDone(e) }));
}

async function markDone(e) {
  haptic('light');
  state.events = state.events.map((x) => (x.id === e.id ? { ...x, done: true } : x));
  render();
  try {
    await api(`/api/services/events/${e.id}`, { method: 'PATCH', body: { done: true } });
  } catch (err) {
    if (!state) return;
    state.events = state.events.map((x) => (x.id === e.id ? { ...x, done: false } : x));
    render();
    toast(err && err.status ? `Impossible : ${err.message}` : 'Impossible — le Studio ne répond pas', { kind: 'error' });
  }
}

function appRow(app) {
  return el('li', { class: 'lx-row' },
    el('a', { class: 'lx-row-btn svc-app', href: app.url, target: '_blank', rel: 'noopener noreferrer' },
      el('span', { class: 'lx-row-body' },
        el('span', { class: 'lx-row-title', text: app.name }),
        el('span', { class: 'lx-row-detail', text: app.note })),
      arrow()));
}
