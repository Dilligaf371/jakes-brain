// Settings app: the v1 About view (server address, build, started, shell, Reload, how to
// update) + per-app rows: Weather city (read-only, set in Weather), JakeGPT default model
// (picker from /api/jakegpt/models -> settings gpt.model; a muted "JakeGPT not available" row
// when that module is not loaded / 503 / unreachable), units (°F / °C -> settings weather.units).
// GET /api/apps says which server modules and web apps exist, so nothing here probes a route
// that would 404 (a console error) and the Weather row only links out when Weather is built.
import * as kit from '../../kit.js';
import { connectorSection } from './connector.js';

const { api, el, fmt, toast, haptic, navbar, section, actionSheet, icon, shellVersion, nav } = kit;

let state = null;
let els = null;
let listeners = [];

export default {
  mount(root) {
    state = { settings: {}, version: null, models: null, modelsError: null, serverApps: null, webApps: null };

    const about = {
      base: el('span', { class: 'v mono', text: location.origin }),
      build: el('span', { class: 'v mono', text: '—' }),
      started: el('span', { class: 'v', text: '—' }),
      shell: el('span', { class: 'v', text: shellVersion() }),
    };
    const kv = (label, value) => el('div', { class: 'kv' }, el('span', { class: 'k', text: label }), value);
    const aboutCard = el('div', { class: 'card' },
      kv('Server', about.base), kv('Build', about.build), kv('Server started', about.started), kv('Shell', about.shell));
    const reload = el('button', { class: 'button', type: 'button', text: 'Reload', 'on:click': () => location.reload() });

    // Weather city (read-only here; the Weather app sets it)
    const cityValue = el('span', { class: 'right', text: '—' });
    const cityRow = el('button', { class: 'row tappable', type: 'button', 'on:click': openWeather },
      el('span', { class: 'label', text: 'Weather city' }), cityValue, chevron());
    const cityHint = el('p', { class: 'hint', text: 'Set it in Weather.' });

    // JakeGPT model picker
    const modelValue = el('span', { class: 'right', text: '—' });
    const modelRow = el('button', { class: 'row tappable', type: 'button', 'on:click': pickModel },
      el('span', { class: 'label', text: 'JakeGPT model' }), modelValue, chevron());

    // Units
    const unitF = el('button', { type: 'button', text: '°F', 'aria-pressed': 'true', 'on:click': () => setUnits('fahrenheit') });
    const unitC = el('button', { type: 'button', text: '°C', 'aria-pressed': 'false', 'on:click': () => setUnits('celsius') });
    const unitsRow = el('div', { class: 'row' },
      el('span', { class: 'label', text: 'Units' }),
      el('div', { class: 'segmented', role: 'group', 'aria-label': 'Units' }, unitF, unitC));

    const appsCard = el('div', { class: 'card' }, cityRow, modelRow, unitsRow);

    root.append(
      navbar({ title: 'Settings' }),
      el('div', { class: 'app-content' },
        aboutCard,
        reload,
        section('Apps'),
        appsCard,
        cityHint,
        connectorSection(),
        section('How to update'),
        el('p', { class: 'blurb', text: 'App updates arrive automatically. Keep the PC on and connected to the internet to use Jake’s Brain anywhere.' }),
      ),
    );
    els = { about, cityValue, cityRow, modelValue, modelRow, unitF, unitC };

    load();
    listen(window, 'jakesdata:online', load);
    listen(window, 'jakesdata:foreground', load);
  },

  unmount() {
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

function chevron() {
  const c = icon('chevron-right', { size: 20 });
  c.classList.add('chev');
  return c;
}

// Weather is a separate app; while it is not built, say so here instead of bouncing the
// user out of Settings.
function openWeather() {
  if (state && state.webApps && !state.webApps.includes('weather')) {
    toast('Weather is not built yet');
    return;
  }
  nav.go('#/weather');
}

async function load() {
  if (!state) return;
  const [version, settings, apps] = await Promise.all([
    api('/api/version').catch(() => null),
    api('/api/settings').catch(() => null),
    api('/api/apps', { timeout: 5000 }).catch(() => null),
  ]);
  if (!state) return;
  if (version) state.version = version;
  if (settings && settings.settings) state.settings = settings.settings;
  state.serverApps = apps && Array.isArray(apps.apps) ? apps.apps.map(String) : null;
  state.webApps = apps && Array.isArray(apps.web) ? apps.web.map(String) : null;
  // Only ask JakeGPT for its models when its server module is loaded (otherwise the route is a 404).
  const hasGpt = Boolean(state.serverApps && state.serverApps.includes('jakegpt'));
  const models = hasGpt
    ? await api('/api/jakegpt/models', { timeout: 6000 }).then((m) => ({ ok: true, value: m })).catch((err) => ({ ok: false, error: err }))
    : { ok: false, error: new Error('JakeGPT is not installed') };
  if (!state) return;
  if (models.ok && models.value && Array.isArray(models.value.models)) {
    state.models = models.value;
    state.modelsError = null;
  } else {
    state.models = null;
    state.modelsError = models.error || new Error('no models');
  }
  render();
}

function render() {
  if (!state || !els) return;
  const v = state.version;
  els.about.build.textContent = v && v.build ? v.build : '—';
  els.about.started.textContent = v && v.started ? fmt.date(v.started, { time: true }) : '—';
  els.about.shell.textContent = shellVersion();

  const city = state.settings['weather.city'];
  els.cityValue.textContent = typeof city === 'string' && city ? city : 'Not set';
  els.cityValue.classList.toggle('muted', !city);
  els.cityRow.classList.toggle('unbuilt', Boolean(state.webApps && !state.webApps.includes('weather')));

  if (state.models) {
    const chosen = state.settings['gpt.model'] || state.models.default || '—';
    els.modelValue.textContent = chosen;
    els.modelValue.classList.remove('muted');
    els.modelRow.disabled = false;
    els.modelRow.classList.remove('unavailable');
  } else {
    els.modelValue.textContent = 'JakeGPT not available';
    els.modelValue.classList.add('muted');
    els.modelRow.disabled = true;
    els.modelRow.classList.add('unavailable');
  }

  const units = state.settings['weather.units'] === 'celsius' ? 'celsius' : 'fahrenheit';
  els.unitF.setAttribute('aria-pressed', String(units === 'fahrenheit'));
  els.unitC.setAttribute('aria-pressed', String(units === 'celsius'));
}

async function pickModel() {
  if (!state || !state.models) return;
  const chosen = state.settings['gpt.model'] || state.models.default;
  const actions = state.models.models.map((m) => ({
    label: m.size ? `${m.name} · ${fmt.bytes(m.size)}` : m.name,
    value: m.name,
    selected: m.name === chosen,
  }));
  if (!actions.length) {
    toast('Ollama has no models yet');
    return;
  }
  const value = await actionSheet({ title: 'JakeGPT model', actions });
  if (!value || value === chosen) return;
  await saveSetting('gpt.model', value);
}

async function setUnits(units) {
  if (!state) return;
  const current = state.settings['weather.units'] === 'celsius' ? 'celsius' : 'fahrenheit';
  if (units === current) return;
  haptic('light');
  await saveSetting('weather.units', units);
}

async function saveSetting(key, value) {
  if (!state) return;
  const before = { ...state.settings };
  state.settings = { ...state.settings, [key]: value };
  render();
  try {
    const data = await api('/api/settings', { method: 'PATCH', body: { [key]: value } });
    if (state && data && data.settings) {
      state.settings = data.settings;
      render();
    }
  } catch (err) {
    if (!state) return;
    state.settings = before;
    render();
    toast(err && err.status ? `Couldn't save: ${err.message}` : "Couldn't save — the PC is unreachable", { kind: 'error' });
    haptic('error');
  }
}
