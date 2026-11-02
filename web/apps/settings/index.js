// Settings app: the v1 About view (server address, build, started, shell, Reload, how to
// update) + per-app rows: Weather city (read-only, set in Weather), JakeGPT default model
// (picker from /api/jakegpt/models -> settings gpt.model; a muted "JakeGPT not available" row
// when that endpoint is missing / 503 / unreachable), units (°F / °C -> settings weather.units).
import * as kit from '../../kit.js';

const { api, el, fmt, toast, haptic, navbar, section, actionSheet, icon, shellVersion, nav } = kit;

let state = null;
let els = null;
let listeners = [];

export default {
  mount(root) {
    state = { settings: {}, version: null, models: null, modelsError: null };

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
    const cityRow = el('button', { class: 'row tappable', type: 'button', 'on:click': () => nav.go('#/weather') },
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
        section('How to update'),
        el('p', { class: 'blurb', html: 'Edit <code>web/</code> or <code>server/</code> in <code>~/jakes-data-app</code> on the PC (or run <code>deploy/deploy.sh</code> from the Mac). The app refreshes itself within 30 seconds.' }),
      ),
    );
    els = { about, cityValue, modelValue, modelRow, unitF, unitC };

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

async function load() {
  if (!state) return;
  const [version, settings, models] = await Promise.all([
    api('/api/version').catch(() => null),
    api('/api/settings').catch(() => null),
    api('/api/jakegpt/models', { timeout: 6000 }).then((m) => ({ ok: true, value: m })).catch((err) => ({ ok: false, error: err })),
  ]);
  if (!state) return;
  if (version) state.version = version;
  if (settings && settings.settings) state.settings = settings.settings;
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
