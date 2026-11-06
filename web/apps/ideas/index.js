// Ideas app: ICO's ready-made asks as a gallery of 3D icons (Khalas-style). A tap hands the
// prompt to ICO (see ../../ideas.js). Static: no server routes.
import * as kit from '../../kit.js';
import { IDEAS, ideaIcon, askICO, inICOApp } from '../../ideas.js';

const { el, navbar } = kit;

export default {
  mount(root) {
    const lead = el('p', {
      class: 'ideas-lead',
      text: inICOApp()
        ? 'Touchez une idée : ICO l’ouvre dans le chat, vous n’avez plus qu’à envoyer.'
        : 'Touchez une idée : elle part dans l’Inbox d’ICO.',
    });
    const grid = el('div', { class: 'ideas-grid' }, ...IDEAS.map(card));
    root.append(navbar({ title: 'Ideas' }), el('div', { class: 'app-content' }, lead, grid));
  },
  unmount() {},
};

function card(idea) {
  return el('button', { class: 'idea-card', type: 'button', 'on:click': () => askICO(idea) },
    el('img', { class: 'idea-art', src: ideaIcon(idea), alt: '', loading: 'lazy', draggable: 'false' }),
    el('span', { class: 'idea-title', text: idea.title }));
}
