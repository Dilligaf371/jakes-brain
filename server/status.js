// Machine + service status for GET /api/status. Never throws; missing pieces are null.
// Budget: each systemctl call has a 1 s timeout (plus an independent 1.1 s deadline in case
// the child ignores the kill) and all run in parallel, so the whole collection finishes
// well under 1.5 s. On a machine without systemctl (the Mac) every service reports "unknown".
import os from 'node:os';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';

const ACTIVE_STATES = new Set(['active', 'inactive', 'failed', 'activating', 'deactivating']);
const SYSTEMCTL_TIMEOUT_MS = 1000;
const DEADLINE_MS = SYSTEMCTL_TIMEOUT_MS + 100;
const UNKNOWN = Object.freeze({ active: 'unknown', since: null });

// Once systemctl is found to be missing we stop spawning it (saves 8 failed spawns a call).
let systemctlMissing = false;

export async function collectStatus(config) {
  const services = Array.isArray(config && config.services) ? config.services : [];
  const [disk, serviceStates] = await Promise.all([diskUsage('/'), collectServices(services)]);
  return {
    host: safe(() => os.hostname()),
    time: new Date().toISOString(),
    uptime_s: safe(() => Math.round(os.uptime())),
    load: safe(() => os.loadavg().map((n) => Math.round(n * 100) / 100)),
    mem: safe(() => {
      const total = os.totalmem();
      return { total, used: total - os.freemem() };
    }),
    disk,
    addresses: safe(addresses),
    services: serviceStates,
  };
}

function safe(fn) {
  try {
    const value = fn();
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

async function diskUsage(mount) {
  try {
    const st = await fsp.statfs(mount);
    const total = Number(st.bsize) * Number(st.blocks);
    const used = Number(st.bsize) * (Number(st.blocks) - Number(st.bfree));
    return { path: mount, total, used };
  } catch {
    return null;
  }
}

// tailscale = first IPv4 starting "100." on an interface named tailscale*;
// lan = first non-internal IPv4 on any other interface.
function addresses() {
  const interfaces = os.networkInterfaces();
  let tailscale = null;
  let lan = null;
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.internal) continue;
      if (addr.family !== 'IPv4' && addr.family !== 4) continue;
      if (name.startsWith('tailscale')) {
        if (!tailscale && addr.address.startsWith('100.')) tailscale = addr.address;
      } else if (!lan) {
        lan = addr.address;
      }
    }
  }
  return { tailscale, lan };
}

async function collectServices(list) {
  return Promise.all(
    list.map(async (service) => {
      const unit = String(service.unit || '');
      const label = service.label ? String(service.label) : unit;
      const state = unit ? await queryUnit(unit, service.scope) : UNKNOWN;
      return { unit, label, active: state.active, since: state.since };
    }),
  );
}

function queryUnit(unit, scope) {
  return new Promise((resolve) => {
    if (systemctlMissing) return resolve(UNKNOWN);
    let settled = false;
    let deadline = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };
    // execFile's timeout only reports once the child has actually exited; a child stuck in
    // uninterruptible I/O must not hold /api/status past its budget, so race it.
    deadline = setTimeout(() => finish(UNKNOWN), DEADLINE_MS);
    deadline.unref();

    const args = scope === 'system' ? [] : ['--user'];
    args.push('show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'ActiveEnterTimestamp');
    let child;
    try {
      child = execFile(
        'systemctl',
        args,
        { timeout: SYSTEMCTL_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8', windowsHide: true },
        (err, stdout) => {
          if (err) {
            if (err.code === 'ENOENT') systemctlMissing = true;
            // Timed out, killed, or exited non-zero: we do not know.
            return finish(UNKNOWN);
          }
          finish(parseShow(stdout));
        },
      );
    } catch {
      return finish(UNKNOWN);
    }
    child.on('error', () => finish(UNKNOWN));
  });
}

function parseShow(output) {
  const props = {};
  for (const line of String(output).split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  // systemd answers "LoadState=not-found ActiveState=inactive" for a unit it has never heard
  // of (misnamed, uninstalled, or a system unit asked for in user scope). That is not a
  // stopped service, it is a service we know nothing about.
  if (props.LoadState !== undefined && props.LoadState !== 'loaded') return UNKNOWN;
  const state = props.ActiveState;
  return {
    active: ACTIVE_STATES.has(state) ? state : 'unknown',
    since: parseSystemdTimestamp(props.ActiveEnterTimestamp),
  };
}

// systemd prints e.g. "Wed 2026-10-29 10:12:03 PDT" (local time of the systemctl process,
// which is the same machine and TZ as this server), "... UTC", or "@1761761523" with
// --timestamp=unix. Empty / "n/a" for units that never started.
export function parseSystemdTimestamp(value) {
  if (!value || value === 'n/a') return null;
  const unix = /^@(\d+)$/.exec(value);
  if (unix) return new Date(Number(unix[1]) * 1000).toISOString();
  const m = /^(?:[A-Za-z]{3} )?(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?: (\S+))?$/.exec(value);
  if (m) {
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
    const tz = m[7];
    const date = tz === 'UTC' ? new Date(Date.UTC(y, mo - 1, d, h, mi, s)) : new Date(y, mo - 1, d, h, mi, s);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
