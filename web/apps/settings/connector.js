// Settings → Claude connector: the address to add in Claude, its public address, whether it is
// running, the password Jake signs in with, what is signed in, and Sign everything out.
// Data: /api/connector (server/apps/connector.js), setting connector.publicUrl.
import { api, el, toast, haptic, section, confirmSheet, fmt } from '../../kit.js';
import { formSheet } from '../../form.js';

export function connectorSection() {
  const status = el('span', { class: 'right', text: '—' });
  const addr = el('span', { class: 'right', text: '—' });
  const pass = el('span', { class: 'right', text: '—' });
  const urlBox = el('textarea', { class: 'input mono connector-url', readonly: true, rows: '2', 'aria-label': 'Connector address' });
  const copy = el('button', { class: 'button', type: 'button', text: 'Copy address', 'on:click': () => copyUrl() });
  const signOut = el('button', { class: 'button connector-signout', type: 'button', text: 'Sign everything out', 'on:click': () => doSignOut() });
  const hint = el('p', { class: 'hint' });
  const sessions = el('div');
  const card = el('div', { class: 'card' },
    el('div', { class: 'row' }, el('span', { class: 'label', text: 'Status' }), status),
    el('button', { class: 'row tappable', type: 'button', 'on:click': () => editAddress() },
      el('span', { class: 'label', text: 'Public address' }), addr),
    el('button', { class: 'row tappable', type: 'button', 'on:click': () => editPassword() },
      el('span', { class: 'label', text: 'Password' }), pass),
    sessions);
  const wrap = el('div', { class: 'connector' }, section('Claude connector'), card, hint, urlBox, copy, signOut);
  let info = null;

  function render() {
    if (!info) {
      status.textContent = 'Not installed';
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    status.textContent = info.listening ? (info.lastCall ? `Used ${usedAgo(info.lastCall.at)}` : 'Running') : 'Not running';
    addr.textContent = info.publicUrl || 'Not set';
    addr.classList.toggle('muted', !info.publicUrl);
    pass.textContent = info.lockedUntil ? 'Locked' : (info.passwordSet ? 'Change' : 'Set one');
    pass.classList.toggle('muted', info.passwordSet && !info.lockedUntil);
    sessions.replaceChildren(...info.signedIn.map((s) => el('div', { class: 'row' },
      el('span', { class: 'label', text: s.name }),
      el('span', { class: 'right muted', text: s.lastUsed ? `Signed in, ${usedAgo(s.lastUsed)}` : 'Signed in' }))));
    urlBox.value = info.url || '';
    urlBox.hidden = copy.hidden = !info.url || !info.passwordSet;
    signOut.hidden = !info.signedIn.length;
    if (!info.url) hint.textContent = 'Set the public address of the tunnel (see deploy/connector/README.md) to connect Claude.';
    else if (!info.passwordSet) hint.textContent = 'Set a password. You type it when Claude asks you to sign in.';
    else hint.textContent = 'In Claude: Customize → Connectors → Add → Add custom connector. Paste this address, then sign in with your password.';
  }

  function usedAgo(at) {
    const when = fmt.relTime(at);
    return /^\d/.test(when) ? `${when} ago` : when;
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

  async function editPassword() {
    const values = await formSheet({
      title: info && info.passwordSet ? 'Change password' : 'Set a password',
      fields: [
        { key: 'password', label: `New password (at least ${info.passwordMin} characters)`, type: 'password', required: true },
        { key: 'again', label: 'Type it again', type: 'password', required: true },
      ],
    });
    if (!values || values === 'delete') return;
    if (values.password !== values.again) return toast("Those don't match", { kind: 'error' });
    try {
      info = await api('/api/connector/password', { method: 'PUT', body: { password: values.password } });
      render();
      haptic('success');
      toast('Password saved');
    } catch (err) {
      toast(`Couldn't save: ${err.message}`, { kind: 'error' });
    }
  }

  async function doSignOut() {
    const ok = await confirmSheet({
      title: 'Sign everything out?',
      message: 'Claude loses access right away. You will need to sign in again from Claude.',
      confirmLabel: 'Sign out',
      destructive: true,
    });
    if (!ok) return;
    try {
      info = await api('/api/connector/sessions', { method: 'DELETE' });
      render();
      haptic('success');
    } catch (err) {
      toast(`Couldn't sign out: ${err.message}`, { kind: 'error' });
    }
  }

  wrap.hidden = true;
  load();
  return wrap;
}
