// Grocery app: a shopping list grouped by aisle. Type an item and Add (the server remembers or
// guesses its aisle), tap the circle to put it in the cart, tap the name to edit qty / aisle /
// delete, "Clear" in the nav bar empties the cart. "Buy again" chips re-add past items in one
// tap. Data: /api/grocery.
import * as kit from '../../kit.js';
import { formSheet } from '../../form.js';

const { api, el, toast, haptic, navbar, navButton, section, emptyState, holdReload, releaseReload, store, icon, confirmSheet } = kit;

const DRAFT_KEY = 'grocery.draft';
const HOLD_KEY = 'grocery:typing';
const FALLBACK_AISLES = ['Produce', 'Bakery', 'Meat & Seafood', 'Dairy & Eggs', 'Pantry', 'Frozen', 'Snacks', 'Drinks', 'Household', 'Other'];

let state = null;
let els = null;
let listeners = [];

export default {
  mount(root) {
    state = { items: [], recent: [], aisles: FALLBACK_AISLES, loaded: false, inflight: false };

    const input = el('input', {
      class: 'input grocery-input', type: 'text', name: 'name', placeholder: 'Add an item', maxlength: '200',
      autocapitalize: 'sentences', autocorrect: 'on', enterkeyhint: 'done', 'aria-label': 'Add an item', autocomplete: 'off',
    });
    const add = el('button', { class: 'grocery-add', type: 'submit', text: 'Add' });
    const form = el('form', { class: 'grocery-form', autocomplete: 'off' }, input, add);
    const recentTitle = section('Buy again');
    const recent = el('div', { class: 'chips grocery-recent', role: 'list' });
    const needed = el('div', { class: 'grocery-needed' });
    const empty = emptyState('Your list is empty.');
    empty.hidden = true;
    const cartTitle = section('In the cart');
    const cart = el('ul', { class: 'card list grocery-list grocery-cart', 'aria-label': 'In the cart' });
    const clear = navButton({ label: 'Clear', onClick: clearCart });
    clear.hidden = true;

    root.append(
      navbar({ title: 'Groceries', right: [clear] }),
      el('div', { class: 'app-content' }, form, recentTitle, recent, needed, empty, cartTitle, cart),
    );
    els = { input, add, form, recentTitle, recent, needed, empty, cartTitle, cart, clear };

    const draft = store.get(DRAFT_KEY, '');
    if (typeof draft === 'string' && draft) input.value = draft;
    syncAdd();
    render();

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      input.value = '';
      store.del(DRAFT_KEY);
      syncAdd();
      syncHold();
      addItem({ name });
    });
    input.addEventListener('input', () => {
      syncAdd();
      store.set(DRAFT_KEY, input.value);
      syncHold();
    });
    input.addEventListener('focus', syncHold);
    input.addEventListener('blur', () => releaseReload(HOLD_KEY));

    load();
    listen(window, 'jakesdata:online', load);
    listen(window, 'jakesdata:foreground', load);
    listen(document, 'visibilitychange', () => { if (!document.hidden) load(); });
  },

  unmount() {
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners = [];
    releaseReload(HOLD_KEY);
    state = null;
    els = null;
  },
};

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  listeners.push([target, type, fn]);
}

function syncHold() {
  if (!els) return;
  if (document.activeElement === els.input && els.input.value.trim()) holdReload(HOLD_KEY);
  else releaseReload(HOLD_KEY);
}

function syncAdd() {
  if (els) els.add.disabled = els.input.value.trim().length === 0;
}

async function load() {
  if (!state || state.inflight) return;
  state.inflight = true;
  try {
    const data = await api('/api/grocery');
    if (!state) return;
    state.items = Array.isArray(data.items) ? data.items : [];
    state.recent = Array.isArray(data.recent) ? data.recent : [];
    if (Array.isArray(data.aisles) && data.aisles.length) state.aisles = data.aisles;
    state.loaded = true;
    render();
  } catch {
    /* keep whatever is on screen; the banner reports the outage */
  } finally {
    if (state) state.inflight = false;
  }
}

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

function aisleIndex(aisle) {
  const i = state.aisles.indexOf(aisle);
  return i === -1 ? state.aisles.length : i;
}

function byAisleThenNewest(a, b) {
  return (aisleIndex(a.aisle) - aisleIndex(b.aisle)) ||
    (Date.parse(b.created_at) - Date.parse(a.created_at)) ||
    (b.id - a.id);
}

function render() {
  if (!state || !els) return;
  const needed = state.items.filter((i) => !i.got).sort(byAisleThenNewest);
  const got = state.items.filter((i) => i.got).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));

  // Needed items, one card per aisle in store order.
  const groups = [];
  for (const item of needed) {
    const last = groups[groups.length - 1];
    if (last && last.aisle === item.aisle) last.items.push(item);
    else groups.push({ aisle: item.aisle, items: [item] });
  }
  els.needed.replaceChildren(...groups.flatMap((g) => [
    section(g.aisle),
    el('ul', { class: 'card list grocery-list', 'aria-label': g.aisle }, ...g.items.map(itemRow)),
  ]));

  els.cart.replaceChildren(...got.map(itemRow));
  els.cart.hidden = got.length === 0;
  els.cartTitle.hidden = got.length === 0;
  els.clear.hidden = got.length === 0;

  const recent = state.recent.filter((r) => !state.items.some((i) => sameName(i.name, r.name)));
  els.recent.replaceChildren(...recent.map((r) => el('button', {
    class: 'chip', type: 'button', role: 'listitem',
    text: r.qty ? `${r.name} · ${r.qty}` : r.name,
    'aria-label': `Add ${r.name} again`,
    'on:click': () => addItem({ name: r.name, qty: r.qty, aisle: r.aisle }),
  })));
  els.recent.hidden = recent.length === 0;
  els.recentTitle.hidden = recent.length === 0;

  els.empty.hidden = !(state.loaded && needed.length === 0);
  els.empty.textContent = got.length ? 'Everything is in the cart.' : 'Your list is empty.';
}

function itemRow(item) {
  const check = el('button', {
    class: 'check', type: 'button', role: 'checkbox',
    'aria-checked': String(item.got),
    'aria-label': item.got ? `Take ${item.name} out of the cart` : `Put ${item.name} in the cart`,
    'on:click': () => toggleItem(item.id),
  }, icon('check', { size: 14, strokeWidth: 2.6 }));
  const label = el('button', {
    class: 'grocery-label', type: 'button', 'aria-label': `Edit ${item.name}`,
    'on:click': () => editItem(item.id),
  }, el('span', { class: 'name', text: item.name }), item.qty ? el('span', { class: 'qty', text: item.qty }) : null);
  return el('li', { class: item.pending ? 'grocery-item pending' : 'grocery-item', dataset: { id: item.id } }, check, label);
}

function failureMessage(verb, err) {
  if (err && err.status === 404) return `That item is gone (${verb} skipped)`;
  if (err && err.status) return `Couldn't ${verb}: ${err.message}`;
  return `Couldn't ${verb} — the PC is unreachable`;
}

function replaceItem(id, next) {
  state.items = state.items.map((i) => (i.id === id ? next : i));
}

async function addItem({ name, qty, aisle }) {
  if (!state) return;
  // Already on the list and still needed: don't add a duplicate, just say so.
  if (state.items.some((i) => !i.got && !i.pending && sameName(i.name, name))) {
    toast(`${name} is already on the list`);
    return;
  }
  const tempId = -Date.now();
  const now = new Date().toISOString();
  state.items = [{ id: tempId, name, qty: qty || '', aisle: aisle || 'Other', got: false, created_at: now, updated_at: now, pending: true }, ...state.items];
  state.loaded = true;
  render();
  haptic('success');
  try {
    const body = { name };
    if (qty) body.qty = qty;
    if (aisle) body.aisle = aisle;
    const data = await api('/api/grocery', { method: 'POST', body });
    if (!state) return;
    replaceItem(tempId, data.item);
    render();
    load(); // refresh "Buy again"
  } catch (err) {
    if (!state) return;
    state.items = state.items.filter((i) => i.id !== tempId);
    render();
    if (!els.input.value && !aisle) {
      els.input.value = name;
      store.set(DRAFT_KEY, name);
      syncAdd();
    }
    toast(failureMessage('add', err), { kind: 'error' });
    haptic('error');
  }
}

async function toggleItem(id) {
  if (!state) return;
  const item = state.items.find((i) => i.id === id);
  if (!item || item.pending) return;
  const next = !item.got;
  haptic('light');
  replaceItem(id, { ...item, got: next, updated_at: new Date().toISOString() });
  render();
  try {
    const data = await api(`/api/grocery/${id}`, { method: 'PATCH', body: { got: next } });
    if (!state) return;
    replaceItem(id, data.item);
    render();
  } catch (err) {
    if (!state) return;
    if (err && err.status === 404) state.items = state.items.filter((i) => i.id !== id);
    else replaceItem(id, item);
    render();
    toast(failureMessage('update', err), { kind: 'error' });
    haptic('error');
  }
}

async function editItem(id) {
  if (!state) return;
  const item = state.items.find((i) => i.id === id);
  if (!item || item.pending) return;
  const result = await formSheet({
    title: 'Edit item',
    canDelete: true,
    fields: [
      { key: 'name', label: 'Item', value: item.name, required: true },
      { key: 'qty', label: 'Quantity', value: item.qty, placeholder: 'e.g. 2, 1 lb, a big bag' },
      { key: 'aisle', label: 'Aisle', type: 'select', value: item.aisle, options: state ? state.aisles.map((a) => ({ value: a, label: a })) : [] },
    ],
  });
  if (!state || result === null) return;
  if (result === 'delete') return deleteItem(id);
  const patch = {};
  if (result.name !== item.name) patch.name = result.name;
  if (result.qty !== item.qty) patch.qty = result.qty;
  if (result.aisle !== item.aisle) patch.aisle = result.aisle;
  if (!Object.keys(patch).length) return;
  replaceItem(id, { ...item, ...patch });
  render();
  try {
    const data = await api(`/api/grocery/${id}`, { method: 'PATCH', body: patch });
    if (!state) return;
    replaceItem(id, data.item);
    render();
  } catch (err) {
    if (!state) return;
    if (err && err.status === 404) state.items = state.items.filter((i) => i.id !== id);
    else replaceItem(id, item);
    render();
    toast(failureMessage('save', err), { kind: 'error' });
    haptic('error');
  }
}

async function deleteItem(id) {
  if (!state) return;
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  state.items = state.items.filter((i) => i.id !== id);
  render();
  try {
    await api(`/api/grocery/${id}`, { method: 'DELETE' });
  } catch (err) {
    if (!state || (err && err.status === 404)) return;
    state.items = [...state.items, item];
    render();
    toast(failureMessage('delete', err), { kind: 'error' });
    haptic('error');
  }
}

async function clearCart() {
  if (!state) return;
  const got = state.items.filter((i) => i.got);
  if (!got.length) return;
  const ok = await confirmSheet({
    title: 'Clear the cart?',
    message: `Removes ${got.length} checked-off item${got.length === 1 ? '' : 's'}. They stay under Buy again.`,
    confirmLabel: 'Clear',
    destructive: true,
  });
  if (!ok || !state) return;
  state.items = state.items.filter((i) => !i.got);
  render();
  try {
    await api('/api/grocery/clear', { method: 'POST' });
    haptic('success');
    load();
  } catch (err) {
    if (!state) return;
    state.items = [...state.items, ...got];
    render();
    toast(failureMessage('clear', err), { kind: 'error' });
    haptic('error');
  }
}
