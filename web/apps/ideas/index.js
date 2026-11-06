// Ideas app: ICO's ready-made asks as an editorial list (black & champagne). A tap hands the
// prompt to ICO (see ../../ideas.js). Static: no server routes.
import * as kit from '../../kit.js';
import { IDEAS, ideaRow, inICOApp } from '../../ideas.js';

const { el, navbar } = kit;

export default {
  mount(root) {
    const lead = el('p', {
      class: 'lx-lead',
      text: inICOApp()
        ? 'Choisissez une idée : ICO la prépare dans le chat, vous n’avez plus qu’à envoyer.'
        : 'Choisissez une idée : elle part dans l’Inbox d’ICO.',
    });
    const list = el('ul', { class: 'lx-list' }, ...IDEAS.map((idea, i) => ideaRow(idea, i, { detail: true })));
    root.append(navbar({ title: 'Idées' }), el('div', { class: 'app-content lx-page' }, lead, list));
  },
  unmount() {},
};
