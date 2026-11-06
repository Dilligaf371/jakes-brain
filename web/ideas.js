// ideas.js — ICO's ready-made asks (Khalas-style "Ideas"), shared by the home strip and the Ideas app.
// A tap hands the prompt to ICO: inside the ICO iPhone app (its WKWebView adds "ICORemote" to the
// user agent) it opens ICO's chat with the prompt in the composer, so the owner still presses Send;
// in a plain browser it lands in the Capture inbox for ICO to pick up.
import { api, toast, haptic } from './kit.js';

export const IDEAS = [
  { id: 'brief', icon: 'coffee', title: 'Mon brief du matin', prompt: "Fais-moi le brief du jour : agenda, mails importants, ce qui m'attend." },
  { id: 'week', icon: 'calendar', title: 'Prépare ma semaine', prompt: 'Regarde mon agenda de la semaine et dis-moi où sont les trous, les conflits et ce que je dois préparer.' },
  { id: 'inbox', icon: 'envelope', title: 'Mails en attente', prompt: "Quels mails attendent une réponse de ma part ? Propose-moi des brouillons pour les plus urgents." },
  { id: 'dinner', icon: 'salad', title: 'Trois dîners ce soir', prompt: 'Propose-moi trois dîners simples pour ce soir, avec les étapes.' },
  { id: 'goal', icon: 'target', title: 'Fixer un objectif', prompt: "Aide-moi à fixer un objectif. Demande-moi lequel, puis découpe-le en étapes et ajoute-le à mes Goals." },
  { id: 'workout', icon: 'dumbbell', title: 'Séance de sport', prompt: "Construis-moi une séance de sport de 30 minutes adaptée à aujourd'hui." },
  { id: 'money', icon: 'piggybank', title: 'Où part mon argent', prompt: 'Fais le point sur mes dépenses du mois et dis-moi où je peux économiser.' },
  { id: 'trip', icon: 'suitcase', title: 'Prépare un voyage', prompt: "Aide-moi à préparer un voyage. Demande-moi où, quand et avec qui." },
  { id: 'read', icon: 'book', title: 'Résume un document', prompt: 'Résume-moi le dernier document que je t’ai envoyé, avec ce qu’il me demande et pour quand.' },
  { id: 'gift', icon: 'gift', title: 'Idée cadeau', prompt: "Trouve-moi une idée cadeau. Demande-moi pour qui et le budget." },
  { id: 'evening', icon: 'moon', title: 'Ma journée en bref', prompt: "Résume ma journée : ce qui est fait, ce qui reste, et ce que je dois préparer pour demain." },
  { id: 'think', icon: 'bulb', title: 'Réfléchis avec moi', prompt: "J'ai une idée à creuser. Pose-moi des questions pour m'aider à la clarifier." },
];

export const ideaIcon = (idea) => `/ideas/${idea.icon}.webp`;

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
