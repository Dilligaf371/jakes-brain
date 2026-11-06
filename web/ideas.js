// ideas.js — ICO's ready-made asks ("Ideas"), shared by the home strip and the Ideas app.
// A tap hands the prompt to ICO: inside the ICO iPhone app (its WKWebView adds "ICORemote" to the
// user agent) it opens ICO's chat with the prompt in the composer, so the owner still presses Send;
// in a plain browser it lands in the Capture inbox for ICO to pick up.
import { api, toast, haptic, el } from './kit.js';

export const IDEAS = [
  { id: 'brief', title: 'Mon brief du matin', prompt: "Fais-moi le brief du jour : agenda, mails importants, ce qui m'attend." },
  { id: 'week', title: 'Prépare ma semaine', prompt: 'Regarde mon agenda de la semaine et dis-moi où sont les trous, les conflits et ce que je dois préparer.' },
  { id: 'inbox', title: 'Mails en attente', prompt: "Quels mails attendent une réponse de ma part ? Propose-moi des brouillons pour les plus urgents." },
  { id: 'dinner', title: 'Trois dîners ce soir', prompt: 'Propose-moi trois dîners simples pour ce soir, avec les étapes.' },
  { id: 'goal', title: 'Fixer un objectif', prompt: "Aide-moi à fixer un objectif. Demande-moi lequel, puis découpe-le en étapes et ajoute-le à mes Goals." },
  { id: 'workout', title: 'Séance de sport', prompt: "Construis-moi une séance de sport de 30 minutes adaptée à aujourd'hui." },
  { id: 'money', title: 'Où part mon argent', prompt: 'Fais le point sur mes dépenses du mois et dis-moi où je peux économiser.' },
  { id: 'trip', title: 'Prépare un voyage', prompt: "Aide-moi à préparer un voyage. Demande-moi où, quand et avec qui." },
  { id: 'read', title: 'Résume un document', prompt: 'Résume-moi le dernier document que je t’ai envoyé, avec ce qu’il me demande et pour quand.' },
  { id: 'gift', title: 'Idée cadeau', prompt: "Trouve-moi une idée cadeau. Demande-moi pour qui et le budget." },
  { id: 'evening', title: 'Ma journée en bref', prompt: "Résume ma journée : ce qui est fait, ce qui reste, et ce que je dois préparer pour demain." },
  { id: 'think', title: 'Réfléchis avec moi', prompt: "J'ai une idée à creuser. Pose-moi des questions pour m'aider à la clarifier." },
];

export function inICOApp() {
  return /ICORemote/.test(navigator.userAgent);
}

export async function askICO(idea) {
  haptic('light');
  if (inICOApp()) {
    location.href = `aleria-remote://chat?ask=${encodeURIComponent(idea.prompt)}`;
    return;
  }
  try {
    await api('/api/capture', { method: 'POST', body: { text: idea.prompt, kind: 'ask', source: 'idea' } });
    toast("Envoyé à ICO via l'Inbox");
  } catch {
    toast("Impossible d'envoyer — le Studio ne répond pas", { kind: 'error' });
    haptic('error');
  }
}

// One editorial row: champagne index, serif title, the ask itself as a quiet second line.
export function ideaRow(idea, index, { detail = false } = {}) {
  return el('li', { class: 'lx-row' },
    el('button', { class: 'lx-row-btn', type: 'button', 'on:click': () => askICO(idea) },
      el('span', { class: 'lx-num', text: String(index + 1).padStart(2, '0') }),
      el('span', { class: 'lx-row-body' },
        el('span', { class: 'lx-row-title', text: idea.title }),
        detail ? el('span', { class: 'lx-row-detail', text: idea.prompt }) : null),
      arrow()));
}

export function arrow() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'lx-arrow');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M5 12h13M13 6.5 18.5 12 13 17.5');
  svg.append(path);
  return svg;
}
