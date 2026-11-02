// Weather: a thin proxy over Open-Meteo (no API key). Routes:
//   GET /api/weather/search?q=            -> [{ name, admin1, country, lat, lon }]  (top 5, geocoding)
//   GET /api/weather?lat=&lon=&units=     -> { current, hourly (next 24 h), daily (7 d), units, timezone, fetched_at, cached, stale }
//
// Forecasts are fetched from Open-Meteo in one canonical unit set (°C, km/h) and cached for
// 10 minutes per lat/lon, in memory and in the `weather_cache` table (so the last forecast
// survives a restart and can be shown when Open-Meteo is unreachable: `stale: true`). The
// units query only changes the conversion, so a °F/°C toggle never hits the network. Every
// real network fetch bumps a counter that is written to the server log (one debug line per
// forecast/search call) and nowhere else.
import { HttpError } from '../http.js';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_MS = 10 * 60_000;         // fresh for 10 minutes
const KEEP_MS = 7 * 24 * 60 * 60_000; // stale rows older than a week are pruned from the table
const FETCH_TIMEOUT_MS = 8_000;
const SEARCH_MAX = 5;
const QUERY_MAX = 100;
const HOURS = 24;
const DAYS = 7;
const UNITS = { fahrenheit: 'fahrenheit', f: 'fahrenheit', celsius: 'celsius', c: 'celsius' };

export default {
  id: 'weather',
  migrations: [
    {
      id: 'weather-1',
      sql: `
        CREATE TABLE IF NOT EXISTS weather_cache (
          key        TEXT PRIMARY KEY,
          payload    TEXT NOT NULL,
          fetched_at TEXT NOT NULL
        );
      `,
    },
  ],
  register(r, ctx) {
    const { log, tools, settings, cfg } = ctx;
    const table = cacheTable(ctx.db);
    const memory = new Map();   // key -> { at, data }  (canonical forecast, °C / km/h)
    const inflight = new Map(); // key -> Promise<{ at, data }>
    const searches = new Map(); // query -> { at, results }
    const counters = { forecast: 0, search: 0 };

    function defaultUnits() {
      const fromSettings = settings.get('weather.units');
      const fromCfg = cfg.weather && cfg.weather.units;
      return UNITS[String(fromSettings || fromCfg || 'fahrenheit').toLowerCase()] || 'fahrenheit';
    }

    r.get('/api/weather/search', async (req, res, { query }) => {
      const q = typeof query.q === 'string' ? query.q.trim().replace(/\s+/g, ' ') : '';
      if (!q) throw new HttpError(400, 'q is required');
      if (q.length > QUERY_MAX) throw new HttpError(400, `q is too long (max ${QUERY_MAX} characters)`);
      const key = q.toLowerCase();
      const hit = searches.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS) {
        log(`search "${q}": cache hit (fetches so far: ${counters.search})`);
        return hit.results;
      }
      counters.search += 1;
      log(`open-meteo fetch #${counters.search} geocoding "${q}"`);
      const url = `${GEOCODE_URL}?${new URLSearchParams({ name: q, count: String(SEARCH_MAX), language: 'en', format: 'json' })}`;
      let data;
      try {
        data = await fetchUpstream(url, `geocoding "${q}"`);
      } catch (err) {
        throw upstreamError(err);
      }
      const results = (Array.isArray(data && data.results) ? data.results : [])
        .filter((p) => p && Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude)))
        .slice(0, SEARCH_MAX)
        .map((p) => ({
          name: String(p.name || '').trim(),
          admin1: p.admin1 ? String(p.admin1) : null,
          country: p.country ? String(p.country) : null,
          lat: round(Number(p.latitude), 4),
          lon: round(Number(p.longitude), 4),
        }));
      searches.set(key, { at: Date.now(), results });
      if (searches.size > 200) searches.delete(searches.keys().next().value);
      return results;
    });

    r.get('/api/weather', async (req, res, { query }) => {
      const lat = parseCoord(query.lat, 'lat', 90);
      const lon = parseCoord(query.lon, 'lon', 180);
      let units = defaultUnits();
      if (query.units !== undefined) {
        units = UNITS[String(query.units).toLowerCase()];
        if (!units) throw new HttpError(400, 'units must be "fahrenheit" or "celsius"');
      }
      const key = cacheKey(lat, lon);
      const { entry, cached, stale } = await forecastFor(key, lat, lon);
      return shape(entry, units, { cached, stale });
    });

    // Fresh memory entry -> fresh table row -> network; on a network failure the newest
    // stale copy (memory or table) is returned with stale: true; with no copy at all, 502.
    async function forecastFor(key, lat, lon) {
      const now = Date.now();
      const mem = memory.get(key);
      if (mem && now - mem.at < CACHE_MS) {
        log(`forecast ${key}: memory cache hit, age ${Math.round((now - mem.at) / 1000)} s (fetches so far: ${counters.forecast})`);
        return { entry: mem, cached: true, stale: false };
      }
      const row = mem || table.get(key);
      if (row && now - row.at < CACHE_MS) {
        memory.set(key, row);
        log(`forecast ${key}: table cache hit, age ${Math.round((now - row.at) / 1000)} s (fetches so far: ${counters.forecast})`);
        return { entry: row, cached: true, stale: false };
      }
      if (!inflight.has(key)) {
        const p = fetchForecast(key, lat, lon).finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      try {
        const fresh = await inflight.get(key);
        memory.set(key, fresh);
        table.put(key, fresh);
        return { entry: fresh, cached: false, stale: false };
      } catch (err) {
        if (row) {
          log.warn(`forecast ${key}: ${err.message}; serving stale data from ${new Date(row.at).toISOString()}`);
          memory.set(key, row);
          return { entry: row, cached: true, stale: true };
        }
        throw upstreamError(err);
      }
    }

    async function fetchForecast(key, lat, lon) {
      counters.forecast += 1;
      log(`open-meteo fetch #${counters.forecast} forecast ${key}`);
      const params = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day',
        hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
        daily: 'temperature_2m_min,temperature_2m_max,weather_code,precipitation_probability_max',
        timezone: 'auto',
        forecast_days: String(DAYS),
        temperature_unit: 'celsius',
        wind_speed_unit: 'kmh',
      });
      const raw = await fetchUpstream(`${FORECAST_URL}?${params}`, `forecast ${key}`);
      const data = canonical(raw, lat, lon);
      if (!data) throw Object.assign(new Error('Open-Meteo returned an unexpected response'), { status: 502 });
      return { at: Date.now(), data };
    }

    // One retry for a network-level failure (a dropped connection, a timeout); an answer
    // from Open-Meteo itself (4xx/5xx) is final. The reason always lands in the log.
    async function fetchUpstream(url, what) {
      try {
        return await tools.fetchJson(url, { timeout: FETCH_TIMEOUT_MS });
      } catch (err) {
        if (err && err.status) {
          log.warn(`${what}: Open-Meteo answered ${err.status}: ${err.message}`);
          throw err;
        }
        log.warn(`${what}: ${err && err.message ? err.message : err}; retrying once`);
        try {
          return await tools.fetchJson(url, { timeout: FETCH_TIMEOUT_MS });
        } catch (again) {
          log.warn(`${what}: retry failed: ${again && again.message ? again.message : again}`);
          throw again;
        }
      }
    }
  },
};

// ---------------------------------------------------------------- helpers

function parseCoord(raw, name, limit) {
  if (raw === undefined || raw === '') throw new HttpError(400, `${name} is required`);
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.abs(n) > limit) throw new HttpError(400, `${name} must be a number between -${limit} and ${limit}`);
  return n;
}

function cacheKey(lat, lon) {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

function round(n, digits = 0) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// tools.fetchJson errors: status 0 = network/timeout; otherwise Open-Meteo's own { reason }.
function upstreamError(err) {
  if (err instanceof HttpError) return err;
  const status = err && err.status;
  if (!status) return new HttpError(502, 'Open-Meteo is unreachable');
  const reason = err.body && typeof err.body === 'object' && err.body.reason ? `: ${err.body.reason}` : '';
  return new HttpError(502, `Open-Meteo error ${status}${reason}`);
}

// Trims Open-Meteo's answer to what the app needs, in °C / km/h. Keeps every forecast hour
// (7 days) so the "next 24 h" window is cut at response time, not at fetch time.
function canonical(raw, lat, lon) {
  if (!raw || typeof raw !== 'object' || !raw.current || !raw.hourly || !raw.daily) return null;
  const c = raw.current;
  const h = raw.hourly;
  const d = raw.daily;
  if (!Array.isArray(h.time) || !Array.isArray(d.time)) return null;
  const hourly = h.time.map((time, i) => ({
    time: String(time),
    temp: num(h.temperature_2m && h.temperature_2m[i]),
    code: num(h.weather_code && h.weather_code[i]),
    precip: num(h.precipitation_probability && h.precipitation_probability[i]),
    isDay: h.is_day && h.is_day[i] != null ? Number(h.is_day[i]) === 1 : null,
  }));
  const daily = d.time.slice(0, DAYS).map((date, i) => ({
    date: String(date),
    min: num(d.temperature_2m_min && d.temperature_2m_min[i]),
    max: num(d.temperature_2m_max && d.temperature_2m_max[i]),
    code: num(d.weather_code && d.weather_code[i]),
    precip: num(d.precipitation_probability_max && d.precipitation_probability_max[i]),
  }));
  return {
    lat,
    lon,
    timezone: typeof raw.timezone === 'string' ? raw.timezone : null,
    utcOffset: num(raw.utc_offset_seconds) || 0,
    current: {
      temp: num(c.temperature_2m),
      feels: num(c.apparent_temperature),
      code: num(c.weather_code),
      wind: num(c.wind_speed_10m),
      humidity: num(c.relative_humidity_2m),
      time: typeof c.time === 'string' ? c.time : null,
      isDay: c.is_day != null ? Number(c.is_day) === 1 : null,
    },
    hourly,
    daily,
  };
}

// The response: converted to the requested units, hourly cut to the next 24 h in the
// location's local time (Open-Meteo's times carry no offset; utcOffset tells us "now" there).
function shape(entry, units, { cached, stale }) {
  const data = entry.data;
  const f = units === 'fahrenheit';
  const temp = (v) => (v == null ? null : Math.round(f ? v * 9 / 5 + 32 : v));
  const wind = (v) => (v == null ? null : Math.round(f ? v / 1.609344 : v));
  const nowLocal = new Date(Date.now() + data.utcOffset * 1000);
  const two = (x) => String(x).padStart(2, '0');
  const hourKey = `${nowLocal.getUTCFullYear()}-${two(nowLocal.getUTCMonth() + 1)}-${two(nowLocal.getUTCDate())}T${two(nowLocal.getUTCHours())}:00`;
  let start = data.hourly.findIndex((x) => x.time >= hourKey);
  if (start < 0) start = Math.max(0, data.hourly.length - HOURS);
  return {
    lat: data.lat,
    lon: data.lon,
    timezone: data.timezone,
    units: { temp: units, wind: f ? 'mph' : 'kmh' },
    current: {
      temp: temp(data.current.temp),
      feels: temp(data.current.feels),
      code: data.current.code,
      wind: wind(data.current.wind),
      humidity: data.current.humidity,
      time: data.current.time,
      isDay: data.current.isDay,
    },
    hourly: data.hourly.slice(start, start + HOURS).map((x) => ({ time: x.time, temp: temp(x.temp), code: x.code, precip: x.precip, isDay: x.isDay })),
    daily: data.daily.map((x) => ({ date: x.date, min: temp(x.min), max: temp(x.max), code: x.code, precip: x.precip })),
    fetched_at: new Date(entry.at).toISOString(),
    cached: Boolean(cached),
    stale: Boolean(stale),
  };
}

function cacheTable(db) {
  const getStmt = db.prepare('SELECT payload, fetched_at FROM weather_cache WHERE key = ?');
  const putStmt = db.prepare(`
    INSERT INTO weather_cache (key, payload, fetched_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
  `);
  const pruneStmt = db.prepare('DELETE FROM weather_cache WHERE fetched_at < ?');
  return {
    get(key) {
      const row = getStmt.get(key);
      if (!row) return null;
      const at = Date.parse(row.fetched_at);
      if (!Number.isFinite(at)) return null;
      try {
        const data = JSON.parse(row.payload);
        return data && Array.isArray(data.hourly) && Array.isArray(data.daily) && data.current ? { at, data } : null;
      } catch {
        return null;
      }
    },
    put(key, entry) {
      try {
        putStmt.run(key, JSON.stringify(entry.data), new Date(entry.at).toISOString());
        pruneStmt.run(new Date(Date.now() - KEEP_MS).toISOString());
      } catch { /* the cache is best-effort; a busy database must not fail the forecast */ }
    },
  };
}
