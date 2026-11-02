// Shared helpers for the Workout app: units, number formatting, set labels, the exercise
// library cache, and the in-progress workout draft (localStorage + the server copy).
import { api, store, debounce } from '../../kit.js';

export const LB_PER_KG = 2.2046226218;
export const M_PER_MI = 1609.344;
export const MUSCLES = ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Legs', 'Glutes', 'Core', 'Cardio', 'Full Body', 'Other'];
export const EQUIPMENT = ['Barbell', 'Dumbbell', 'Machine', 'Cable', 'Bodyweight', 'Kettlebell', 'Band', 'Other'];
export const KIND_LABELS = { weight: 'Weight & reps', reps: 'Reps only', time: 'Duration', cardio: 'Distance & time' };
export const SET_KIND_LABELS = { normal: 'Normal set', warmup: 'Warm-up set', drop: 'Drop set', failure: 'Failure set' };
export const REST_CHOICES = [0, 30, 45, 60, 90, 120, 150, 180, 240, 300];
export const DEFAULT_REST = 90;

// ---------------------------------------------------------------- units

let units = store.get('workout.units', 'lb') === 'kg' ? 'kg' : 'lb';
export const getUnits = () => units;
export const distUnit = () => (units === 'kg' ? 'km' : 'mi');

export async function loadUnits() {
  try {
    const { settings } = await api('/api/settings');
    const u = settings && settings['workout.units'];
    if (u === 'kg' || u === 'lb') {
      units = u;
      store.set('workout.units', u);
    }
  } catch { /* keep the cached choice */ }
  return units;
}

export async function setUnits(u) {
  units = u === 'kg' ? 'kg' : 'lb';
  store.set('workout.units', units);
  try { await api('/api/settings', { method: 'PATCH', body: { 'workout.units': units } }); } catch { /* local still applies */ }
}

const trim = (n, digits = 1) => {
  const f = 10 ** digits;
  return String(Math.round(n * f) / f);
};

// kg -> number in the given unit (rounded for display)
export const kgTo = (kg, u = units) => (u === 'kg' ? kg : kg * LB_PER_KG);
export const toKg = (v, u = units) => (u === 'kg' ? v : v / LB_PER_KG);
export const metersTo = (m, u = units) => (u === 'kg' ? m / 1000 : m / M_PER_MI);
export const toMeters = (v, u = units) => (u === 'kg' ? v * 1000 : v * M_PER_MI);

export const fmtWeight = (kg, u = units) => (kg === null || kg === undefined ? '' : trim(kgTo(kg, u), 1));
export const fmtDist = (m, u = units) => (m === null || m === undefined ? '' : trim(metersTo(m, u), 2));
export const fmtVolume = (kg) => `${Math.round(kgTo(kg)).toLocaleString()} ${units}`;

// seconds -> "1:30" / "1:02:05"
export function fmtClock(sec) {
  if (sec === null || sec === undefined || sec === '') return '';
  const s = Math.max(0, Math.round(Number(sec)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const two = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

// seconds -> "1h 5m" / "45m" / "40s"
export function fmtLong(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return `${m}m`;
  return `${s}s`;
}

// Typed digits -> clock text: "130" -> "1:30", "45" -> "45", "10000" -> "1:00:00".
export function digitsToClock(raw) {
  const d = String(raw).replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 6);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, -2)}:${d.slice(-2)}`;
  return `${d.slice(0, -4)}:${d.slice(-4, -2)}:${d.slice(-2)}`;
}

export function clockToSeconds(text) {
  if (text === null || text === undefined || text === '') return null;
  const parts = String(text).split(':').map((p) => Number(p || 0));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// One set as short text: "135 lb × 8", "× 12", "1:30", "1.5 mi · 12:00"
export function setText(kind, s) {
  if (kind === 'weight') {
    const w = s.weight_kg ? `${fmtWeight(s.weight_kg)} ${units}` : '';
    return w ? `${w} × ${s.reps ?? 0}` : `${s.reps ?? 0} reps`;
  }
  if (kind === 'reps') return `${s.reps ?? 0} reps`;
  if (kind === 'time') return fmtClock(s.seconds || 0);
  const parts = [];
  if (s.meters) parts.push(`${fmtDist(s.meters)} ${distUnit()}`);
  if (s.seconds) parts.push(fmtClock(s.seconds));
  return parts.join(' · ') || '—';
}

// Labels for a list of sets: warm-ups "W", drops "D", failures "F", normal sets numbered.
export function setLabels(sets) {
  let n = 0;
  return sets.map((s) => {
    if (s.kind === 'warmup') return 'W';
    if (s.kind === 'drop') return 'D';
    if (s.kind === 'failure') return 'F';
    n += 1;
    return String(n);
  });
}

export const e1rm = (w, r) => (!w || !r ? 0 : r <= 1 ? w : w * (1 + r / 30));

export const PR_LABELS = {
  weight: 'Heaviest weight', e1rm: 'Best est. 1RM', volume: 'Best set volume',
  reps: 'Most reps', time: 'Longest time', distance: 'Longest distance',
};

export function prValue(type, value) {
  if (type === 'weight' || type === 'e1rm') return `${fmtWeight(value)} ${units}`;
  if (type === 'volume') return fmtVolume(value);
  if (type === 'reps') return `${value} reps`;
  if (type === 'time') return fmtClock(value);
  return `${fmtDist(value)} ${distUnit()}`;
}

// ---------------------------------------------------------------- exercise library

let library = null;
let libraryInflight = null;
export function loadLibrary(force = false) {
  if (library && !force) return Promise.resolve(library);
  if (!libraryInflight) {
    libraryInflight = api('/api/workout/exercises')
      .then((data) => {
        library = data.exercises || [];
        return library;
      })
      .finally(() => { libraryInflight = null; });
  }
  return libraryInflight;
}
export const cachedLibrary = () => library || [];
export const exerciseById = (id) => (library || []).find((e) => e.id === id) || null;

// ---------------------------------------------------------------- the in-progress workout

const ACTIVE_KEY = 'workout.active';
const PUSHED_KEY = 'workout.activePushed'; // started_at of the draft the server has seen
let uidSeq = 0;
export const uid = () => `${Date.now().toString(36)}${(uidSeq++).toString(36)}`;

export function blankSet(kind = 'normal') {
  return { uid: uid(), kind, w: '', r: '', t: '', d: '', done: false };
}

// Server set (kg / m / s) -> draft set (strings in the current units)
export function draftSet(s, done = false) {
  return {
    uid: uid(),
    kind: s.kind || 'normal',
    w: s.weight_kg ? fmtWeight(s.weight_kg) : '',
    r: s.reps === null || s.reps === undefined ? '' : String(s.reps),
    t: s.seconds ? fmtClock(s.seconds) : '',
    d: s.meters ? fmtDist(s.meters) : '',
    done,
  };
}

// Draft set -> server set, or null when it has nothing in it.
export function serverSet(kind, s, u) {
  const n = (v) => {
    const x = Number(String(v).replace(',', '.'));
    return v === '' || !Number.isFinite(x) || x < 0 ? null : x;
  };
  const out = { kind: s.kind, weight_kg: null, reps: null, seconds: null, meters: null };
  if (kind === 'weight') {
    const w = n(s.w);
    out.weight_kg = w === null ? null : Math.round(toKg(w, u) * 1000) / 1000;
    out.reps = n(s.r) === null ? null : Math.round(n(s.r));
    if (!out.reps && !out.weight_kg) return null;
  } else if (kind === 'reps') {
    out.reps = n(s.r) === null ? null : Math.round(n(s.r));
    if (!out.reps) return null;
  } else if (kind === 'time') {
    out.seconds = clockToSeconds(s.t);
    if (!out.seconds) return null;
  } else {
    const d = n(s.d);
    out.meters = d === null ? null : Math.round(toMeters(d, u) * 10) / 10;
    out.seconds = clockToSeconds(s.t);
    if (!out.meters && !out.seconds) return null;
  }
  return out;
}

export function draftExercise(ex, sets, rest) {
  return {
    uid: uid(),
    exercise_id: ex.exercise_id ?? ex.id,
    name: ex.name,
    kind: ex.kind,
    muscle: ex.muscle,
    rest: rest !== undefined ? rest : (ex.kind === 'cardio' ? 0 : DEFAULT_REST),
    note: ex.note || '',
    sets,
  };
}

export function readActive() {
  const d = store.get(ACTIVE_KEY, null);
  return d && typeof d === 'object' && Array.isArray(d.exercises) ? d : null;
}

const pushActive = debounce(() => {
  const d = readActive();
  if (!d) return;
  api('/api/workout/active', { method: 'PUT', body: { active: d } })
    .then(() => store.set(PUSHED_KEY, d.started_at))
    .catch(() => {});
}, 1200);

export function writeActive(draft) {
  draft.updated = Date.now();
  store.set(ACTIVE_KEY, draft);
  pushActive();
}

export async function clearActive() {
  pushActive.cancel();
  store.del(ACTIVE_KEY);
  store.del(PUSHED_KEY);
  try { await api('/api/workout/active', { method: 'DELETE' }); } catch { /* best effort */ }
}

// Picks the newer of this device's draft and the server's (a workout started on the PC
// shows up on the phone and the other way round).
export async function syncActive() {
  const local = readActive();
  try {
    const { active } = await api('/api/workout/active');
    const remote = active && Array.isArray(active.exercises) ? active : null;
    if (remote && (!local || (remote.updated || 0) > (local.updated || 0))) {
      store.set(ACTIVE_KEY, remote);
      return remote;
    }
    if (!remote && local) {
      // The server forgot it (finished or discarded elsewhere) only if it was pushed before.
      if (store.get(PUSHED_KEY, null) === local.started_at) {
        store.del(ACTIVE_KEY);
        store.del(PUSHED_KEY);
        return null;
      }
    }
  } catch { /* offline: use what this device has */ }
  return readActive();
}
