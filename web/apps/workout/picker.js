// Full-screen exercise picker: search, muscle filter chips, multi-select (or single select
// for "Replace"), and "New exercise" for custom ones. Resolves an array of library exercises
// (empty when cancelled).
import { el, api, toast, haptic, icon, holdReload, releaseReload } from '../../kit.js';
import { formSheet } from '../../form.js';
import { loadLibrary, MUSCLES, EQUIPMENT, KIND_LABELS } from './lib.js';

export async function createExercise(name = '') {
  const result = await formSheet({
    title: 'New exercise',
    saveLabel: 'Create',
    fields: [
      { key: 'name', label: 'Name', value: name, required: true, placeholder: 'e.g. Incline Cable Fly' },
      { key: 'muscle', label: 'Muscle group', type: 'select', value: 'Chest', options: MUSCLES.map((m) => ({ value: m, label: m })) },
      { key: 'equipment', label: 'Equipment', type: 'select', value: 'Barbell', options: EQUIPMENT.map((m) => ({ value: m, label: m })) },
      { key: 'kind', label: 'Tracks', type: 'select', value: 'weight', options: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })) },
    ],
  });
  if (!result || result === 'delete') return null;
  try {
    const { exercise } = await api('/api/workout/exercises', { method: 'POST', body: result });
    await loadLibrary(true);
    haptic('success');
    return exercise;
  } catch (err) {
    toast(err && err.status ? err.message : "Couldn't create it — the PC is unreachable", { kind: 'error' });
    return null;
  }
}

export function pickExercises({ title = 'Add exercises', single = false } = {}) {
  return new Promise((resolve) => {
    const HOLD = 'workout:picker';
    holdReload(HOLD);
    let library = [];
    let muscle = '';
    const chosen = [];

    const search = el('input', {
      class: 'input', type: 'search', placeholder: 'Search exercises', autocomplete: 'off',
      autocorrect: 'off', autocapitalize: 'off', 'aria-label': 'Search exercises', enterkeyhint: 'search',
    });
    const chips = el('div', { class: 'chips' });
    const list = el('ul', { class: 'card list wo-pick-list', 'aria-label': 'Exercises' });
    const addBtn = el('button', { type: 'button', class: 'wo-pick-add', text: single ? '' : 'Add', disabled: true });
    const finish = (value) => {
      releaseReload(HOLD);
      window.removeEventListener('hashchange', onHash);
      document.removeEventListener('keydown', onKey);
      panel.remove();
      resolve(value);
    };
    const appOf = () => location.hash.split('/')[1] || '';
    const openedIn = appOf();
    const onHash = () => { if (appOf() !== openedIn) finish([]); };
    const onKey = (e) => { if (e.key === 'Escape') finish([]); };
    addBtn.addEventListener('click', () => finish(chosen.slice()));

    const panel = el('div', { class: 'app-workout wo-picker', role: 'dialog', 'aria-label': title },
      el('div', { class: 'wo-picker-head' },
        el('button', { type: 'button', text: 'Cancel', 'on:click': () => finish([]) }),
        el('strong', { text: title }),
        addBtn),
      el('div', { class: 'wo-picker-body' },
        search, chips,
        el('button', {
          type: 'button', class: 'wo-pick-new',
          'on:click': async () => {
            const ex = await createExercise(search.value.trim());
            if (!ex) return;
            if (single) return finish([ex]);
            library = await loadLibrary();
            chosen.push(ex);
            render();
          },
        }, icon('plus', { size: 20 }), el('span', { text: 'New exercise' })),
        list));

    function renderChips() {
      chips.replaceChildren(...['', ...MUSCLES].map((m) => el('button', {
        type: 'button', class: 'chip', text: m || 'All', 'aria-pressed': String(muscle === m),
        'on:click': () => { muscle = m; renderChips(); render(); },
      })));
    }

    function render() {
      const q = search.value.trim().toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const hits = library.filter((e) => (!muscle || e.muscle === muscle) &&
        words.every((w) => `${e.name} ${e.muscle} ${e.equipment}`.toLowerCase().includes(w)));
      // Recently used first when not searching, like a "Recent" section.
      const recent = !q && !muscle ? hits.filter((e) => e.last_used).sort((a, b) => b.last_used.localeCompare(a.last_used)).slice(0, 8) : [];
      const rows = [];
      if (recent.length) {
        rows.push(el('li', { class: 'wo-pick-group', text: 'Recent' }), ...recent.map(row));
        rows.push(el('li', { class: 'wo-pick-group', text: 'All exercises' }));
      }
      rows.push(...hits.map(row));
      if (!hits.length) rows.push(el('li', { class: 'wo-pick-empty', text: 'No matches. Tap “New exercise” to add it.' }));
      list.replaceChildren(...rows);
      addBtn.disabled = chosen.length === 0;
      if (!single) addBtn.textContent = chosen.length ? `Add (${chosen.length})` : 'Add';
    }

    function row(e) {
      const on = chosen.some((c) => c.id === e.id);
      return el('li', null, el('button', {
        type: 'button', class: `wo-pick-row${on ? ' on' : ''}`, 'aria-pressed': String(on),
        'on:click': () => {
          haptic('light');
          if (single) return finish([e]);
          const i = chosen.findIndex((c) => c.id === e.id);
          if (i === -1) chosen.push(e);
          else chosen.splice(i, 1);
          render();
        },
      },
      el('span', { class: 'wo-pick-text' },
        el('span', { class: 'wo-pick-name', text: e.name }),
        el('span', { class: 'wo-pick-meta', text: `${e.muscle} · ${e.equipment}${e.times ? ` · ${e.times}×` : ''}` })),
      el('span', { class: 'wo-pick-check' }, icon('check', { size: 16, strokeWidth: 2.6 }))));
    }

    search.addEventListener('input', render);
    window.addEventListener('hashchange', onHash);
    document.addEventListener('keydown', onKey);
    document.body.append(panel);
    renderChips();
    list.replaceChildren(el('li', { class: 'wo-pick-empty', text: 'Loading…' }));
    loadLibrary().then((lib) => { library = lib; render(); }).catch(() => {
      list.replaceChildren(el('li', { class: 'wo-pick-empty', text: "Couldn't load exercises — the PC is unreachable." }));
    });
  });
}
