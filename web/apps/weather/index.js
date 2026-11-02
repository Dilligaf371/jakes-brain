// Weather app: an Open-Meteo forecast for one city. Two screens: search (no city set yet, or
// "Change" in the nav bar -> #/weather/search) and main (city + current temperature,
// condition, feels like / wind / humidity, an hourly strip, a 7-day list with min/max bars,
// a °F/°C toggle). Data: GET /api/weather (server-cached 10 min) and the settings
// weather.city / weather.lat / weather.lon / weather.units via /api/settings. The last
// forecast is kept in kit.store so the app still shows something when the PC or Open-Meteo
// is unreachable (toast + "Showing saved data"). Glyphs are inline SVG strokes, no emoji.
import * as kit from '../../kit.js';

const { api, el, toast, haptic, navbar, section, emptyState, holdReload, releaseReload, store, debounce, navButton, icon, fmt, nav } = kit;

const LAST_KEY = 'weather.last';     // { place, data, at } of the last forecast shown
const HOLD_KEY = 'weather:typing';
const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_MIN_CHARS = 2;
const REFRESH_MS = 10 * 60_000;      // the server cache is 10 min; refresh the view on that cadence
const PRECIP_SHOW_AT = 10;           // show the chance of rain from 10 % up
const SVG_NS = 'http://www.w3.org/2000/svg';

// WMO weather codes -> short label + glyph name.
const CODES = {
  0: ['Clear', 'sun'], 1: ['Mostly clear', 'sun'], 2: ['Partly cloudy', 'partly'], 3: ['Overcast', 'cloud'],
  45: ['Fog', 'fog'], 48: ['Rime fog', 'fog'],
  51: ['Light drizzle', 'rain'], 53: ['Drizzle', 'rain'], 55: ['Heavy drizzle', 'rain'],
  56: ['Freezing drizzle', 'rain'], 57: ['Freezing drizzle', 'rain'],
  61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'rain'],
  66: ['Freezing rain', 'rain'], 67: ['Freezing rain', 'rain'],
  71: ['Light snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'], 77: ['Snow grains', 'snow'],
  80: ['Light showers', 'rain'], 81: ['Showers', 'rain'], 82: ['Heavy showers', 'rain'],
  85: ['Snow showers', 'snow'], 86: ['Heavy snow showers', 'snow'],
  95: ['Thunderstorm', 'storm'], 96: ['Thunderstorm, hail', 'storm'], 99: ['Thunderstorm, hail', 'storm'],
};

// 24x24 stroke glyphs. A cloud that sits over something (sun, moon) carries class "occ" and
// is filled with the surface colour by the CSS so the hidden part of the sun stays hidden.
const CLOUD = 'M7 18.5h10.5a3.5 3.5 0 0 0 0-7h-.6A5.5 5.5 0 0 0 6.2 10.9 3.9 3.9 0 0 0 7 18.5z';
const CLOUD_HIGH = 'M7 15h10.5a3.5 3.5 0 0 0 0-7h-.6A5.5 5.5 0 0 0 6.2 7.4 3.9 3.9 0 0 0 7 15z';
const SUN_RAYS = 'M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6';
const MOON = 'M20 14.3A8 8 0 0 1 9.7 4a8 8 0 1 0 10.3 10.3z';
const GLYPHS = {
  sun: [{ d: 'M12 12m-4.2 0a4.2 4.2 0 1 0 8.4 0a4.2 4.2 0 1 0-8.4 0' }, { d: SUN_RAYS }],
  moon: [{ d: MOON }],
  cloud: [{ d: CLOUD }],
  partly: [
    { d: 'M8.5 8.5m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0' },
    { d: 'M8.5 2.8v1.6M2.8 8.5h1.6M4.5 4.5l1.1 1.1M12.5 4.5l-1.1 1.1M4.5 12.5l1.1-1.1' },
    { d: 'M9.5 20h9.3a3.1 3.1 0 0 0 0-6.2h-.5A4.6 4.6 0 0 0 9.4 12.3 3.5 3.5 0 0 0 9.5 20z', occ: true },
  ],
  'partly-night': [
    { d: 'M13.2 8.6A4.6 4.6 0 0 1 7.3 2.9a4.6 4.6 0 1 0 5.9 5.7z' },
    { d: 'M9.5 20h9.3a3.1 3.1 0 0 0 0-6.2h-.5A4.6 4.6 0 0 0 9.4 12.3 3.5 3.5 0 0 0 9.5 20z', occ: true },
  ],
  rain: [{ d: CLOUD_HIGH }, { d: 'M9 18l-1 3.2M13 18l-1 3.2M17 18l-1 3.2' }],
  snow: [{ d: CLOUD_HIGH }, { d: 'M8.5 18.5h.01M12.5 21h.01M16.5 18.5h.01M12.5 17h.01M8.5 21h.01M16.5 21h.01', dots: true }],
  storm: [{ d: CLOUD_HIGH }, { d: 'M13 15.5l-2.6 3.8h3.2L11 23' }],
  fog: [{ d: CLOUD_HIGH }, { d: 'M6 18.5h12M8 21.5h8' }],
};

let state = null;
let els = null;
let listeners = [];
let refreshTimer = 0;
let searchCtl = null;
let runSearch = null;

export default {
  mount(root, ctx) {
    state = {
      root,
      sub: ctx && ctx.sub ? ctx.sub : '',
      settingsLoaded: false,
      settingsError: null,
      place: null,          // { city, lat, lon }
      units: 'fahrenheit',
      forecast: null,       // the /api/weather payload on screen
      forecastAt: 0,
      saved: false,         // forecast came from kit.store (PC unreachable)
      loading: false,
      error: null,
      inflight: null,
      fromMain: false,      // the search screen was opened with "Change" (back returns to main)
      query: '',
      results: [],
      searching: false,
    };
    runSearch = debounce(doSearch, SEARCH_DEBOUNCE_MS);

    const last = store.get(LAST_KEY, null);
    if (validLast(last)) {
      state.place = last.place;
      state.forecast = last.data;
      state.forecastAt = last.at;
      state.saved = true;
      state.units = last.data.units && last.data.units.temp === 'celsius' ? 'celsius' : 'fahrenheit';
    }

    show(state.sub);
    loadSettings().then(() => {
      if (!state) return;
      show(state.sub);
      refresh();
    });

    listen(window, 'jakesdata:online', onWake);
    listen(window, 'jakesdata:foreground', onWake);
    listen(document, 'visibilitychange', () => { if (!document.hidden) onWake(); });
    refreshTimer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  },

  route(sub) {
    if (!state) return;
    state.sub = sub || '';
    show(state.sub);
    if (screenFor(state.sub) === 'main' && (!state.forecast || state.saved)) refresh();
  },

  unmount() {
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners = [];
    clearInterval(refreshTimer);
    refreshTimer = 0;
    if (runSearch) runSearch.cancel();
    runSearch = null;
    if (searchCtl) searchCtl.abort();
    searchCtl = null;
    releaseReload(HOLD_KEY);
    state = null;
    els = null;
  },
};

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  listeners.push([target, type, fn]);
}

function validLast(last) {
  return Boolean(last && last.place && Number.isFinite(last.place.lat) && Number.isFinite(last.place.lon)
    && last.data && last.data.current && Array.isArray(last.data.hourly) && Array.isArray(last.data.daily) && Number.isFinite(last.at));
}

// ---------------------------------------------------------------- data

async function loadSettings() {
  if (!state) return;
  try {
    const data = await api('/api/settings');
    if (!state) return;
    const s = (data && data.settings) || {};
    const lat = Number(s['weather.lat']);
    const lon = Number(s['weather.lon']);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const city = typeof s['weather.city'] === 'string' && s['weather.city'].trim() ? s['weather.city'].trim() : `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
      if (!state.place || state.place.lat !== lat || state.place.lon !== lon) {
        state.place = { city, lat, lon };
        state.forecast = null; // a different city than the saved forecast
        state.saved = false;
      } else {
        state.place = { city, lat, lon };
      }
    } else {
      state.place = null;
      state.forecast = null;
      state.saved = false;
    }
    state.units = s['weather.units'] === 'celsius' ? 'celsius' : 'fahrenheit';
    state.settingsLoaded = true;
    state.settingsError = null;
  } catch (err) {
    if (!state) return;
    state.settingsError = err;
    // Not loaded: keep whatever kit.store gave us (place + saved forecast), if anything.
  }
}

function onWake() {
  if (!state) return;
  if (!state.settingsLoaded) {
    loadSettings().then(() => {
      if (!state) return;
      show(state.sub);
      refresh();
    });
  } else {
    refresh();
  }
}

async function refresh() {
  if (!state || !state.place || screenFor(state.sub) !== 'main') return;
  if (state.inflight) return state.inflight;
  const { lat, lon } = state.place;
  const units = state.units;
  state.loading = true;
  state.error = null;
  // With a forecast on screen only the footer changes; a full rebuild would reset the
  // hourly strip's scroll position for nothing.
  if (!state.forecast) renderMain();
  else if (els && els.updated) els.updated.textContent = updatedText();
  const p = api(`/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&units=${units}`, { timeout: 12_000 })
    .then((data) => {
      if (!state || !state.place || state.place.lat !== lat || state.place.lon !== lon) return;
      state.forecast = data;
      state.forecastAt = Date.parse(data.fetched_at) || Date.now();
      state.saved = false;
      state.error = null;
      store.set(LAST_KEY, { place: state.place, data, at: state.forecastAt });
      if (data.stale) toast(`Open-Meteo is unreachable — showing data from ${ago(state.forecastAt)}`, { kind: 'error' });
    })
    .catch((err) => {
      if (!state) return;
      state.error = err;
      const why = err && err.status ? err.message : "can't reach the PC";
      if (state.forecast) toast(`Couldn't refresh (${why}) — showing data from ${ago(state.forecastAt)}`, { kind: 'error' });
      else toast(err && err.status ? err.message : "Can't reach the PC", { kind: 'error' });
    })
    .finally(() => {
      if (!state) return;
      state.loading = false;
      state.inflight = null;
      renderMain();
    });
  state.inflight = p;
  return p;
}

async function setUnits(units) {
  if (!state || units === state.units) return;
  haptic('light');
  const before = state.units;
  state.units = units;
  renderMain();
  try {
    await api('/api/settings', { method: 'PATCH', body: { 'weather.units': units } });
  } catch (err) {
    if (!state) return;
    state.units = before;
    renderMain();
    toast(err && err.status ? `Couldn't save: ${err.message}` : "Couldn't save — the PC is unreachable", { kind: 'error' });
    haptic('error');
    return;
  }
  if (!state) return;
  // The server converts from its cache, so this never waits on Open-Meteo.
  refresh();
}

async function pickPlace(result) {
  if (!state) return;
  haptic('light');
  const city = cityLabel(result);
  const place = { city, lat: result.lat, lon: result.lon };
  try {
    await api('/api/settings', { method: 'PATCH', body: { 'weather.city': city, 'weather.lat': place.lat, 'weather.lon': place.lon } });
  } catch (err) {
    if (!state) return;
    toast(err && err.status ? `Couldn't save: ${err.message}` : "Couldn't save — the PC is unreachable", { kind: 'error' });
    haptic('error');
    return;
  }
  if (!state) return;
  state.place = place;
  state.settingsLoaded = true;
  state.forecast = null;
  state.forecastAt = 0;
  state.saved = false;
  state.error = null;
  state.query = '';
  state.results = [];
  releaseReload(HOLD_KEY);
  if (state.sub === 'search') {
    // Leave the search entry: back to the main screen we came from, or replace it.
    if (state.fromMain) nav.back();
    else nav.replace('#/weather');
  } else {
    show('');
    refresh();
  }
}

// "Austin, Texas" for US places, "Paris, France" elsewhere.
function cityLabel(r) {
  const name = String(r.name || '').trim();
  const region = r.country === 'United States' && r.admin1 ? r.admin1 : (r.country || r.admin1 || '');
  return region && region !== name ? `${name}, ${region}` : name || `${r.lat}, ${r.lon}`;
}

async function doSearch() {
  if (!state) return;
  const q = state.query.trim();
  if (q.length < SEARCH_MIN_CHARS) return;
  if (searchCtl) searchCtl.abort();
  const ctl = new AbortController();
  searchCtl = ctl;
  state.searching = true;
  renderSearchResults();
  try {
    const results = await api(`/api/weather/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal, timeout: 10_000 });
    if (!state || ctl !== searchCtl) return;
    state.results = Array.isArray(results) ? results : [];
    state.searching = false;
    renderSearchResults();
  } catch (err) {
    if (!state || ctl !== searchCtl) return;
    if (err && err.message === 'aborted') return;
    state.searching = false;
    state.results = [];
    renderSearchResults();
    toast(err && err.status ? err.message : "Can't reach the PC", { kind: 'error' });
  } finally {
    if (searchCtl === ctl) searchCtl = null;
  }
}

// ---------------------------------------------------------------- screens

// 'search' (asked for, or no city is set), 'main' (a city is known: from settings or the
// saved forecast), 'error' (no city known and the settings could not be read: the search
// would go through the same unreachable PC), else 'loading' (settings still on their way).
function screenFor(sub) {
  if (sub === 'search') return 'search';
  if (state.place) return 'main';
  if (state.settingsLoaded) return 'search';
  return state.settingsError ? 'error' : 'loading';
}

function show(sub) {
  if (!state) return;
  const screen = screenFor(sub);
  if (screen === 'search') {
    if (sub !== 'search') state.fromMain = false;
    showSearch();
  } else if (screen === 'main') {
    showMain();
  } else {
    showLoading(screen === 'error');
  }
}

function showLoading(failed) {
  const content = el('div', { class: 'app-content' });
  if (failed) {
    const err = state.settingsError;
    content.append(
      emptyState(err && err.status ? `Couldn't load the settings: ${err.message}` : "Can't reach the PC."),
      el('button', { class: 'button', type: 'button', text: 'Try again', 'on:click': onWake }),
    );
  } else {
    content.append(el('p', { class: 'empty', text: 'Loading…' }));
  }
  state.root.replaceChildren(navbar({ title: 'Weather' }), content);
  els = { screen: failed ? 'error' : 'loading' };
}

function showMain() {
  if (els && els.screen === 'main') {
    renderMain();
    return;
  }
  const change = navButton({ label: 'Change', onClick: goSearch });
  const content = el('div', { class: 'app-content main' });
  state.root.replaceChildren(navbar({ title: 'Weather', right: [change] }), content);
  els = { screen: 'main', content };
  renderMain();
}

function goSearch() {
  if (!state) return;
  haptic('light');
  state.fromMain = true;
  nav.go('#/weather/search');
}

function renderMain() {
  if (!state || !els || els.screen !== 'main') return;
  const place = state.place;
  const f = state.forecast;
  const content = els.content;
  const oldStrip = content.querySelector('.strip');
  const stripScroll = oldStrip ? oldStrip.scrollLeft : 0;
  content.replaceChildren();
  els.updated = null;
  if (!place) return;

  const hero = el('div', { class: 'hero' }, el('div', { class: 'city', text: place.city }));
  if (f && f.current) {
    const cur = f.current;
    const [label, glyphName] = describe(cur.code, cur.isDay);
    const today = f.daily && f.daily[0];
    const windUnit = f.units && f.units.wind === 'kmh' ? 'km/h' : 'mph';
    hero.append(
      el('div', { class: 'temp', text: deg(cur.temp) }),
      el('div', { class: 'cond' }, glyph(glyphName, 26), el('span', { text: label })),
      today ? el('div', { class: 'hl', text: `H:${deg(today.max)}  L:${deg(today.min)}` }) : null,
      el('div', { class: 'meta', text: [
        cur.feels != null ? `Feels like ${deg(cur.feels)}` : null,
        cur.wind != null ? `Wind ${cur.wind} ${windUnit}` : null,
        cur.humidity != null ? `Humidity ${cur.humidity}%` : null,
      ].filter(Boolean).join(' · ') }),
    );
  } else if (state.loading) {
    hero.append(el('div', { class: 'hero-note', text: 'Loading…' }));
  } else {
    hero.append(
      el('div', { class: 'hero-note', text: "Couldn't load the forecast." }),
      el('button', { class: 'button', type: 'button', text: 'Try again', 'on:click': () => refresh() }),
    );
  }
  content.append(hero);

  if (f && f.current) {
    const strip = hourlyStrip(f);
    content.append(section('Hourly'), strip);
    content.append(section('7 days'), dailyList(f));
    if (stripScroll) strip.querySelector('.strip').scrollLeft = stripScroll;
  }

  const unitF = el('button', { type: 'button', text: '°F', 'aria-pressed': String(state.units === 'fahrenheit'), 'on:click': () => setUnits('fahrenheit') });
  const unitC = el('button', { type: 'button', text: '°C', 'aria-pressed': String(state.units === 'celsius'), 'on:click': () => setUnits('celsius') });
  content.append(el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('span', { class: 'label', text: 'Units' }),
      el('div', { class: 'segmented', role: 'group', 'aria-label': 'Units' }, unitF, unitC))));

  els.updated = el('p', { class: 'updated', text: updatedText() });
  content.append(els.updated);
}

function updatedText() {
  if (!state.forecast) return '';
  const when = ago(state.forecastAt);
  if (state.saved || state.error) return `Showing saved data from ${when}`;
  if (state.forecast.stale) return `Open-Meteo unreachable · data from ${when}`;
  if (state.loading) return 'Updating…';
  return when === 'just now' ? 'Updated just now' : `Updated ${when}`;
}

function hourlyStrip(f) {
  const hours = Array.isArray(f.hourly) ? f.hourly : [];
  const items = hours.map((h, i) => {
    const temp = i === 0 && f.current && f.current.temp != null ? f.current.temp : h.temp;
    const code = i === 0 && f.current && f.current.code != null ? f.current.code : h.code;
    const isDay = i === 0 && f.current && f.current.isDay != null ? f.current.isDay : h.isDay;
    const [, glyphName] = describe(code, isDay);
    const precip = h.precip != null && h.precip >= PRECIP_SHOW_AT ? `${Math.round(h.precip)}%` : '';
    return el('div', { class: 'hour', role: 'listitem' },
      el('span', { class: 'h-time', text: hourLabel(h.time, i) }),
      el('span', { class: 'h-precip', text: precip }),
      glyph(glyphName, 24),
      el('span', { class: 'h-temp', text: deg(temp) }));
  });
  return el('div', { class: 'card hourly' }, el('div', { class: 'strip', role: 'list', 'aria-label': 'Next 24 hours' }, items));
}

function dailyList(f) {
  const days = Array.isArray(f.daily) ? f.daily : [];
  const mins = days.map((d) => d.min).filter((v) => v != null);
  const maxs = days.map((d) => d.max).filter((v) => v != null);
  const lo = mins.length ? Math.min(...mins) : 0;
  const hi = maxs.length ? Math.max(...maxs) : 1;
  const span = Math.max(1, hi - lo);
  const rows = days.map((d, i) => {
    const [label, glyphName] = describe(d.code, true);
    const left = d.min == null ? 0 : ((d.min - lo) / span) * 100;
    const width = d.min == null || d.max == null ? 0 : Math.max(4, ((d.max - d.min) / span) * 100);
    const precip = d.precip != null && d.precip >= PRECIP_SHOW_AT ? `${Math.round(d.precip)}%` : '';
    const g = glyph(glyphName, 24);
    g.setAttribute('aria-label', label);
    g.setAttribute('role', 'img');
    return el('li', { class: 'day' },
      el('span', { class: 'd-name', text: dayLabel(d.date, i) }),
      el('span', { class: 'd-cond' }, g, el('span', { class: 'd-precip', text: precip })),
      el('span', { class: 'd-min', text: deg(d.min) }),
      el('span', { class: 'd-bar' }, el('span', { class: 'd-fill', style: { left: `${left}%`, width: `${Math.min(width, 100 - left)}%` } })),
      el('span', { class: 'd-max', text: deg(d.max) }));
  });
  return el('ul', { class: 'card daily', 'aria-label': '7-day forecast' }, rows);
}

function showSearch() {
  const hasCity = Boolean(state.place);
  const input = el('input', {
    class: 'input search-input', type: 'search', name: 'q', placeholder: 'City', value: state.query,
    autocapitalize: 'words', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': 'City',
  });
  const form = el('form', { class: 'search-form', autocomplete: 'off' }, icon('search', { size: 20 }), input);
  const list = el('ul', { class: 'card results', 'aria-label': 'Matching places' });
  const note = el('p', { class: 'empty', text: '' });
  const content = el('div', { class: 'app-content search' }, form, list, note);
  state.root.replaceChildren(
    navbar({ title: hasCity ? 'Change city' : 'Weather', back: hasCity && state.sub === 'search' }),
    content,
  );
  els = { screen: 'search', input, list, note };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (runSearch) runSearch.flush();
    input.blur();
  });
  input.addEventListener('input', () => {
    if (!state) return;
    state.query = input.value;
    syncHold();
    if (state.query.trim().length < SEARCH_MIN_CHARS) {
      if (runSearch) runSearch.cancel();
      if (searchCtl) searchCtl.abort();
      searchCtl = null;
      state.results = [];
      state.searching = false;
      renderSearchResults();
      return;
    }
    if (runSearch) runSearch();
  });
  input.addEventListener('focus', syncHold);
  input.addEventListener('blur', () => releaseReload(HOLD_KEY));
  renderSearchResults();
  if (!hasCity || !state.results.length) setTimeout(() => { if (els && els.input === input) input.focus(); }, 260);
}

// Never yank the keyboard away mid-word: hold the build-change reload while typing.
function syncHold() {
  if (!els || els.screen !== 'search') return;
  if (document.activeElement === els.input && els.input.value.trim()) holdReload(HOLD_KEY);
  else releaseReload(HOLD_KEY);
}

function renderSearchResults() {
  if (!state || !els || els.screen !== 'search') return;
  const q = state.query.trim();
  const rows = state.results.map((r) => {
    const sub = [r.admin1, r.country].filter(Boolean).join(' · ');
    return el('li', {},
      el('button', { class: 'row tappable result', type: 'button', 'on:click': () => pickPlace(r) },
        el('span', { class: 'r-text' },
          el('span', { class: 'r-name', text: r.name }),
          sub ? el('span', { class: 'r-sub', text: sub }) : null),
        chevron()));
  });
  els.list.replaceChildren(...rows);
  els.list.hidden = rows.length === 0;
  let note = '';
  if (state.searching && !rows.length) note = 'Searching…';
  else if (q.length < SEARCH_MIN_CHARS) note = state.place ? 'Search for another city.' : 'Search for a city to see its forecast.';
  else if (!rows.length) note = `No matches for “${q}”.`;
  els.note.textContent = note;
  els.note.hidden = !note;
}

function chevron() {
  const c = icon('chevron-right', { size: 20 });
  c.classList.add('chev');
  return c;
}

// ---------------------------------------------------------------- formatting + glyphs

function describe(code, isDay) {
  const entry = CODES[Number(code)] || ['—', 'cloud'];
  let [label, name] = entry;
  if (isDay === false) {
    if (name === 'sun') name = 'moon';
    else if (name === 'partly') name = 'partly-night';
  }
  return [label, name];
}

function glyph(name, size = 24) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `wx wx-${name}`);
  for (const part of GLYPHS[name] || GLYPHS.cloud) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', part.d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', part.dots ? '2.6' : '1.7');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    if (part.occ) path.setAttribute('class', 'occ');
    svg.append(path);
  }
  return svg;
}

function deg(n) {
  return n == null || !Number.isFinite(Number(n)) ? '—' : `${Math.round(Number(n))}°`;
}

// "2026-11-02T13:00" (location-local, no offset) -> "1 PM"; the first slot is "Now".
function hourLabel(time, index) {
  if (index === 0) return 'Now';
  const h = Number(String(time || '').slice(11, 13));
  if (!Number.isFinite(h)) return '—';
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

// "2026-11-03" -> "Tue" (parsed as a local date, never via Date.parse's UTC midnight).
function dayLabel(date, index) {
  if (index === 0) return 'Today';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return '—';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

function ago(at) {
  const rel = fmt.relTime(at);
  return rel === 'now' ? 'just now' : /^\d+[mhd]$/.test(rel) ? `${rel} ago` : rel;
}
