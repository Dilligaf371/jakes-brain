// Deals: brand deals, what's owed, and due dates (mirrored into Calendar by the server).
import * as kit from '../../kit.js';
import { formSheet } from '../../form.js';

const { api, el, fmt, toast, haptic, navbar, navButton, emptyState, section, confirmSheet, nav } = kit;
const STATUSES = [['talking', 'Talking'], ['signed', 'Signed'], ['delivered', 'Delivered'], ['invoiced', 'Invoiced'], ['paid', 'Paid']];
const LABEL = Object.fromEntries(STATUSES);
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const today = () => fmt.dayKey();

let root; let deals = []; let summary = null; let live = false;

const fields = (d = {}) => [
  { key: 'brand', label: 'Brand', value: d.brand, required: true },
  { key: 'status', label: 'Status', type: 'select', value: d.status || 'talking', options: STATUSES.map(([value, label]) => ({ value, label })) },
  { key: 'amount', label: 'Amount ($)', type: 'number', value: d.amount ?? '' },
  { key: 'due_date', label: 'Due date', type: 'date', value: d.due_date || '' },
  { key: 'deliverables', label: 'Deliverables', type: 'textarea', value: d.deliverables, placeholder: '2 reels, 1 story' },
  { key: 'invoice', label: 'Invoice number', value: d.invoice },
  { key: 'notes', label: 'Notes', type: 'textarea', value: d.notes, placeholder: 'Mention people with @name' },
];
async function edit(deal) {
  const result = await formSheet({ title: deal ? deal.brand : 'New deal', fields: fields(deal), canDelete: Boolean(deal) });
  if (!result) return;
  try {
    if (result === 'delete') {
      const ok = await confirmSheet({ title: 'Delete this deal?', message: deal.brand, confirmLabel: 'Delete', destructive: true });
      if (ok) await api(`/api/deals/${deal.id}`, { method: 'DELETE' });
    } else if (deal) {
      await api(`/api/deals/${deal.id}`, { method: 'PATCH', body: result });
    } else {
      await api('/api/deals', { method: 'POST', body: result });
    }
    haptic('success');
    await refresh();
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}
function row(deal) {
  const late = deal.due_date && deal.due_date < today() && !['delivered', 'invoiced', 'paid'].includes(deal.status);
  const due = deal.due_date ? fmt.date(`${deal.due_date}T12:00:00`, { month: 'short', day: 'numeric' }) : '';
  return el('button', { class: 'row tappable', type: 'button', 'on:click': () => edit(deal) },
    el('span', { class: 'label' }, el('span', { class: 'brand', text: deal.brand }),
      el('span', { class: `sub${late ? ' late' : ''}`, text: [LABEL[deal.status], due && `due ${due}`].filter(Boolean).join(' · ') })),
    el('span', { class: 'right', text: deal.amount == null ? '' : money(deal.amount) }));
}
function render() {
  if (!live) return;
  const kv = (label, value) => el('div', { class: 'kv' }, el('span', { class: 'k', text: label }), el('span', { class: 'v', text: money(value) }));
  const open = deals.filter((d) => d.status !== 'paid');
  const paid = deals.filter((d) => d.status === 'paid');
  root.replaceChildren(
    navbar({ title: 'Deals', right: [navButton({ label: 'New deal', icon: 'plus', onClick: () => edit() })] }),
    el('div', { class: 'app-content' },
      summary ? el('div', { class: 'card' }, kv('Owed to you', summary.owed), kv('Coming up', summary.upcoming), kv('Paid', summary.paid)) : null,
      deals.length ? null : emptyState('No deals yet. Tap + to add one.'),
      open.length ? section('Open') : null, open.length ? el('div', { class: 'card' }, open.map(row)) : null,
      paid.length ? section('Paid') : null, paid.length ? el('div', { class: 'card' }, paid.map(row)) : null));
}
async function refresh() {
  ({ deals, summary } = await api('/api/deals'));
  render();
}
function openSub(sub) {
  const deal = deals.find((d) => String(d.id) === String(sub));
  if (deal) { nav.replace('#/deals'); edit(deal); }
}
export default {
  async mount(el_, ctx) {
    root = el_; live = true;
    root.append(navbar({ title: 'Deals' }));
    try { await refresh(); openSub(ctx.sub); } catch (err) { toast(err.message, { kind: 'error' }); }
  },
  route(sub) { openSub(sub); },
  unmount() { live = false; root = null; },
};
