// Settings → Claude connector: the URL to paste into Claude (Settings → Connectors → Add custom
// connector), its public address, whether it is running, and Rotate (a new secret cuts off the
// old URL). Data: /api/connector (server/apps/connector.js), setting connector.publicUrl.
import { api, el, toast, haptic, section, confirmSheet, fmt } from '../../kit.js';
import { formSheet } from '../../form.js';

export function connectorSection() {
  const status = el('span', { class: 'right', text: '—' });
  const addr = el('span', { class: 'right', text: '—' });
  const urlBox = el('textarea', { class: 'input mono connector-url', readonly: true, rows: '3', 'aria-label': 'Connector URL' });
  const copy = el('button', { class: 'button', type: 'button', text: 'Copy URL', 'on:click': () => copyUrl() });
  const rotate = el('button', { class: 'button connector-rotate', type: 'button', text: 'Make a new URL', 'on:click': () => doRotate() });
  const hint = el('p', { class: 'hint' });
  const card = el('div', { class: 'card' },
    el('div', { class: 'row' }, el('span', { class: 'label', text: 'Status' }), status),
    el('button', { class: 'row tappable', type: 'button', 'on:click': () => editAddress() },
      el('span', { class: 'label', text: 'Public address' }), addr));
  const wrap = el('div', { class: 'connector' }, section('Claude connector'), card, hint, urlBox, copy, rotate);
  let info = null;

  function render() {
    if (!info) {
      status.textContent = 'Not installed';
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    status.textContent = info.listening ? (info.lastCall ? `Used ${fmt.relTime(info.lastCall.at)}${/^\d/.test(fmt.relTime(info.lastCall.at)) ? ' ago' : ''}` : 'Running') : 'Not running';
    addr.textContent = info.publicUrl || 'Not set';
    addr.classList.toggle('muted', !info.publicUrl);
    urlBox.value = info.url || '';
    urlBox.hidden = copy.hidden = !info.url;
    hint.textContent = info.url
      ? 'Paste this into Claude: Settings → Connectors → Add custom connector. Anyone with this URL can read and change your data, so keep it private.'
      : 'Set the public address of the tunnel (see deploy/connector/README.md) to get the URL for Claude.';
  }

  async function load() {
    try {
      info = await api('/api/connector');
    } catch {
      info = null;
    }
    render();
  }

  async function copyUrl() {
    if (!info || !info.url) return;
    try {
      await navigator.clipboard.writeText(info.url);
      toast('Copied');
    } catch {
      urlBox.focus();
      urlBox.select();
      toast('Selected: copy it from the box');
    }
  }

  async function editAddress() {
    const values = await formSheet({
      title: 'Public address',
      fields: [{ key: 'publicUrl', label: 'Tunnel address', value: info && info.publicUrl, placeholder: 'https://something.ngrok-free.app' }],
    });
    if (!values || values === 'delete') return;
    const v = values.publicUrl.replace(/\/+$/, '');
    if (v && !/^https:\/\/[^\s/]+$/.test(v)) return toast('Use just https://host, no path', { kind: 'error' });
    try {
      await api('/api/settings', { method: 'PATCH', body: { 'connector.publicUrl': v || null } });
      haptic('success');
      load();
    } catch (err) {
      toast(`Couldn't save: ${err.message}`, { kind: 'error' });
    }
  }

  async function doRotate() {
    const ok = await confirmSheet({
      title: 'Make a new URL?',
      message: 'The old URL stops working right away. You will need to paste the new one into Claude.',
      confirmLabel: 'Make new URL',
      destructive: true,
    });
    if (!ok) return;
    try {
      info = await api('/api/connector/rotate', { method: 'POST' });
      render();
      haptic('success');
    } catch (err) {
      toast(`Couldn't rotate: ${err.message}`, { kind: 'error' });
    }
  }

  wrap.hidden = true;
  load();
  return wrap;
}
