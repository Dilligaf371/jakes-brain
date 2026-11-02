// A bottom-sheet edit form shared by Deals and People.
// formSheet({ title, fields, canDelete }) resolves with the values, 'delete', or null on cancel.
// fields: [{ key, label, type: text|textarea|date|number|select, value, options, placeholder, required }]
import { el, holdReload, releaseReload, toast } from './kit.js';

let linked = false;

export function formSheet({ title, fields, saveLabel = 'Save', canDelete = false }) {
  if (!linked) {
    linked = true;
    document.head.append(el('link', { rel: 'stylesheet', href: '/form.css' }));
  }
  return new Promise((resolve) => {
    const HOLD = 'form:open';
    holdReload(HOLD);
    const inputs = {};
    const finish = (value) => {
      releaseReload(HOLD);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onHash);
      panel.remove();
      resolve(value);
    };
    const onKey = (event) => { if (event.key === 'Escape') finish(null); };
    // The sheet sits above the app layer, so leaving the app must close it too.
    const appOf = () => location.hash.split('/')[1] || '';
    const openedIn = appOf();
    const onHash = () => { if (appOf() !== openedIn) finish(null); };
    const save = () => {
      const values = {};
      for (const field of fields) {
        const raw = inputs[field.key].value.trim();
        if (field.required && !raw) return toast(`${field.label} is required`, { kind: 'error' });
        values[field.key] = field.type === 'number' ? (raw === '' ? null : Number(raw)) : raw;
      }
      return finish(values);
    };
    const control = (field) => {
      const shared = { class: 'input', 'aria-label': field.label, placeholder: field.placeholder || '' };
      if (field.type === 'textarea') return el('textarea', shared);
      if (field.type === 'select') {
        return el('select', { class: 'input', 'aria-label': field.label },
          field.options.map((option) => el('option', { value: option.value, text: option.label })));
      }
      return el('input', { ...shared, type: field.type || 'text', ...(field.type === 'number' ? { inputmode: 'decimal', step: 'any', min: '0' } : {}) });
    };
    const rows = fields.map((field) => {
      const input = control(field);
      input.value = field.value ?? '';
      inputs[field.key] = input;
      return el('label', { class: 'fs-field' }, el('span', { text: field.label }), input);
    });
    const panel = el('div', { class: 'fs-backdrop' },
      el('div', { class: 'fs-panel', role: 'dialog', 'aria-label': title },
        el('div', { class: 'fs-head' },
          el('button', { type: 'button', text: 'Cancel', 'on:click': () => finish(null) }),
          el('strong', { text: title }),
          el('button', { type: 'button', text: saveLabel, 'on:click': save })),
        el('div', { class: 'fs-body' }, rows,
          canDelete ? el('button', { class: 'fs-delete', type: 'button', text: 'Delete', 'on:click': () => finish('delete') }) : null)));
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onHash);
    document.body.append(panel);
  });
}
