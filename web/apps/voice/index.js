// Voice Memos: record in the iPhone shell, or add any audio file. The PC transcribes it and
// copies the text into Notes.
import * as kit from '../../kit.js';

const { api, upload, el, fmt, toast, haptic, navbar, emptyState, confirmSheet, holdReload, releaseReload, nav } = kit;
const HOLD = 'voice:recording';
const POLL_MS = 4000;
let root; let memos = []; let poll = null; let recording = null; let progress = null;
const canRecord = () => Boolean(window.JakesData?.canRecord);
const native = (action) => window.webkit?.messageHandlers?.native?.postMessage({ type: 'voice', action });

async function refresh() {
  try {
    ({ memos } = await api('/api/voice'));
    if (root) render();
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}
function syncPoll() {
  const busy = memos.some((m) => m.status === 'processing');
  if (busy && !poll) poll = setInterval(refresh, POLL_MS);
  if (!busy && poll) { clearInterval(poll); poll = null; }
}
async function addFile(file) {
  if (!file) return;
  progress = 0;
  render();
  try {
    await upload('/api/voice/upload', file, { onProgress: (p) => { progress = p; render(); } });
    haptic('success');
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
  progress = null;
  refresh();
}
function memoCard(m) {
  const status = m.status === 'processing' ? 'Transcribing…' : m.status === 'failed' ? (m.error || 'Transcription failed.') : (m.transcript || 'No speech found.');
  return el('div', { class: 'card memo' },
    el('div', { class: 'top' }, el('span', { class: 'when', text: fmt.date(m.created_at, { month: 'short', day: 'numeric', time: true }) }),
      el('button', { class: 'del', type: 'button', 'aria-label': 'Delete memo', 'on:click': async () => {
        if (!await confirmSheet({ title: 'Delete this memo?', message: 'The audio is removed. The copy in Notes stays.', confirmLabel: 'Delete', destructive: true })) return;
        await api(`/api/voice/${m.id}`, { method: 'DELETE' }).catch((err) => toast(err.message, { kind: 'error' }));
        refresh();
      } }, kit.icon('trash', { size: 20 }))),
    el('audio', { controls: true, preload: 'none', src: `/media/voice/${m.file}` }),
    el('p', { class: `said ${m.status}`, text: status }),
    m.status === 'failed' ? el('button', { class: 'button', type: 'button', text: 'Try again', 'on:click': () => api(`/api/voice/${m.id}/retry`, { method: 'POST' }).then(refresh).catch((err) => toast(err.message, { kind: 'error' })) }) : null,
    m.note_id ? el('button', { class: 'link', type: 'button', text: 'Open in Notes', 'on:click': () => nav.go(`#/notes/${m.note_id}`) }) : null);
}
function render() {
  if (!root) return;
  const picker = el('input', { type: 'file', accept: 'audio/*,.m4a,.mp3,.wav,.aac,.caf', hidden: true, 'on:change': (e) => addFile(e.target.files[0]) });
  const recordBtn = canRecord() ? el('button', { class: `button record${recording ? ' on' : ''}`, type: 'button', text: recording ? 'Stop' : 'Record', 'on:click': () => {
    if (recording) { native('stop'); return; }
    native('start');
  } }) : null;
  root.replaceChildren(navbar({ title: 'Voice Memos' }), el('div', { class: 'app-content' },
    recordBtn,
    recording ? el('p', { class: 'muted center', text: 'Recording…' }) : null,
    el('button', { class: 'button file', type: 'button', disabled: progress !== null, text: progress !== null ? `Uploading ${Math.round(progress * 100)}%` : 'Add an audio file', 'on:click': () => picker.click() }), picker,
    memos.length ? memos.map(memoCard) : emptyState('No memos yet.')));
  syncPoll();
}
function onVoice(event) {
  const { state, message } = event.detail || {};
  if (state === 'recording') { recording = true; holdReload(HOLD); haptic('medium'); }
  if (state === 'uploading') { recording = false; progress = 1; }
  if (state === 'done' || state === 'error') { recording = false; progress = null; releaseReload(HOLD); }
  if (state === 'error') toast(message || 'Recording failed', { kind: 'error' });
  if (state === 'done') haptic('success');
  if (state === 'done') refresh(); else render();
}
export default {
  mount(el_) { root = el_; root.append(navbar({ title: 'Voice Memos' })); window.addEventListener('jakesdata:voice', onVoice); refresh(); },
  unmount() { if (recording) native('stop'); window.removeEventListener('jakesdata:voice', onVoice); clearInterval(poll); poll = null; root = null; recording = null; releaseReload(HOLD); },
};
