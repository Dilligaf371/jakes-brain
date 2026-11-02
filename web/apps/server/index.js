// Server app: the v1 Home view. PC stats (uptime, load, memory, disk) + one row per service
// from server/config.json, refreshed every 30 s while open and on foreground/online.
import * as kit from '../../kit.js';

const { api, el, navbar, section } = kit;

const POLL_MS = 30_000;

let state = null;
let els = null;
let timers = [];
let listeners = [];

export default {
  mount(root) {
    state = { status: null, statusAt: 0, inflight: false };

    const machine = {
      host: el('div', { class: 'card-title', text: '—' }),
      uptime: el('span', { class: 'v', text: '—' }),
      load: el('span', { class: 'v', text: '—' }),
      mem: el('span', { class: 'v', text: '—' }),
      disk: el('span', { class: 'v', text: '—' }),
      diskBar: el('div', { class: 'bar-fill', style: { width: '0%' } }),
    };
    const kv = (label, value) => el('div', { class: 'kv' }, el('span', { class: 'k', text: label }), value);
    const card = el('div', { class: 'card machine', 'aria-label': 'Machine' },
      machine.host,
      kv('Uptime', machine.uptime),
      kv('Load', machine.load),
      kv('Memory', machine.mem),
      el('div', { class: 'kv kv-disk' }, el('span', { class: 'k', text: 'Disk' }), machine.disk),
      el('div', { class: 'bar', 'aria-hidden': 'true' }, machine.diskBar));
    const services = el('ul', { class: 'card list', 'aria-label': 'Services' });
    const updated = el('p', { class: 'updated', 'aria-live': 'off', text: ' ' });

    root.append(
      navbar({ title: 'Server' }),
      el('div', { class: 'app-content' }, card, section('Services'), services, updated),
    );
    els = { machine, services, updated };

    load();
    timers.push(setInterval(() => { if (!document.hidden) load(); }, POLL_MS));
    timers.push(setInterval(() => { if (!document.hidden) renderUpdated(); }, 1000));
    listen(window, 'jakesdata:foreground', load);
    listen(window, 'jakesdata:online', load);
    listen(document, 'visibilitychange', () => { if (!document.hidden) load(); });
  },

  unmount() {
    for (const t of timers) clearInterval(t);
    timers = [];
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners = [];
    state = null;
    els = null;
  },
};

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  listeners.push([target, type, fn]);
}

async function load() {
  if (!state || state.inflight) return;
  state.inflight = true;
  try {
    const status = await api('/api/status');
    if (!state) return;
    state.status = status;
    state.statusAt = Date.now();
    render();
  } catch {
    renderUpdated();
  } finally {
    if (state) state.inflight = false;
  }
}

function render() {
  const s = state && state.status;
  if (!s || !els) return;
  const m = els.machine;
  m.host.textContent = s.host || '—';
  m.uptime.textContent = fmtUptime(s.uptime_s);
  m.load.textContent = Array.isArray(s.load) ? s.load.map((n) => Number(n).toFixed(2)).join('  ') : '—';
  m.mem.textContent = s.mem ? `${fmtGB(s.mem.used, 1)} / ${fmtGB(s.mem.total, 1)} GB` : '—';
  if (s.disk && s.disk.total > 0) {
    m.disk.textContent = `${fmtGB(s.disk.used, 0)} / ${fmtGB(s.disk.total, 0)} GB`;
    const pct = Math.min(100, Math.max(0, (s.disk.used / s.disk.total) * 100));
    m.diskBar.style.width = `${pct.toFixed(1)}%`;
  } else {
    m.disk.textContent = '—';
    m.diskBar.style.width = '0%';
  }
  renderServices(Array.isArray(s.services) ? s.services : []);
  renderUpdated();
}

function renderServices(services) {
  const rows = services.map((svc) => {
    const active = svc.active || 'unknown';
    const right = svc.since ? fmtRel(svc.since) : active;
    return el('li', { class: 'row', title: svc.unit || null },
      el('span', { class: 'dot', 'data-state': active, 'aria-label': active }),
      el('span', { class: 'label', text: svc.label || svc.unit || '—' }),
      el('span', { class: 'right', text: right }));
  });
  if (!rows.length) rows.push(el('li', { class: 'row' }, el('span', { class: 'label muted', text: 'No services configured' })));
  els.services.replaceChildren(...rows);
}

function renderUpdated() {
  if (!els || !state) return;
  if (!state.statusAt) {
    els.updated.textContent = kit.isOffline() ? 'No data yet' : ' ';
    return;
  }
  els.updated.textContent = `Updated ${fmtAgo(Date.now() - state.statusAt)} ago`;
}

function fmtUptime(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtGB(bytes, digits) {
  return Number.isFinite(bytes) ? (bytes / 1e9).toFixed(digits) : '—';
}

// v1 format for the service rows: "now" (< 60 s), "12m", "4h", then "Nd" with no cap (most
// PC services run for weeks; kit's fmt.relTime switches to a date after 7 days).
function fmtRel(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
