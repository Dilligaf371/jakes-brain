// The workout logger, shared by three modes:
//   active  — the workout in progress (live duration, rest timer, Finish; the draft persists
//             to localStorage + the server so it survives reloads and follows Jake across devices)
//   edit    — a saved workout opened for changes (Save → PUT)
//   routine — a routine template (no checkmarks; Save → POST/PUT routine)
// Each exercise is a card with a set table: SET | PREVIOUS | weight/reps/time/distance | ✓.
import * as kit from '../../kit.js';
import { formSheet } from '../../form.js';
import { pickExercises } from './picker.js';
import {
  getUnits, distanceUnit, fmtClock, fmtLong, digitsToClock, setText, setLabels, SET_KIND_LABELS,
  REST_CHOICES, blankSet, draftSet, serverSet, draftExercise, writeActive, clearActive, uid,
} from './lib.js';

const { api, el, toast, haptic, navbar, navButton, icon, confirmSheet, actionSheet, holdReload, releaseReload, nav } = kit;
const HOLD = 'workout:logger';
const WEEKDAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];

function sourceLink(url) {
  try {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) return null;
    return el('a', { class: 'wo-routine-source', href: url, target: '_blank', rel: 'noopener noreferrer', text: 'View original plan' });
  } catch { return null; }
}

export function hasRemainingProgramSets(draft) {
  const planned = new Map();
  for (const ex of draft.planned_exercises || []) planned.set(ex.exercise_id, (planned.get(ex.exercise_id) || 0) + ex.sets);
  const logged = new Map();
  for (const ex of draft.exercises) {
    const count = ex.sets.filter((s) => s.done && serverSet(ex.kind, s, draft.unit, ex.distance_unit)).length;
    logged.set(ex.exercise_id, (logged.get(ex.exercise_id) || 0) + count);
  }
  return planned.size
    ? [...planned].some(([exerciseId, count]) => (logged.get(exerciseId) || 0) < count)
    : draft.exercises.some((ex) => ex.sets.some((s) => !s.done));
}

export function defaultTitle(date = new Date()) {
  const h = date.getHours();
  if (h < 5) return 'Night Workout';
  if (h < 12) return 'Morning Workout';
  if (h < 17) return 'Afternoon Workout';
  if (h < 21) return 'Evening Workout';
  return 'Night Workout';
}

// draft: { mode, id, title, started_at, ended_at, unit, routine_id, notes, rest_end, rest_total, exercises }
export function mountLogger(root, ctx, draft, { onDone } = {}) {
  const mode = draft.mode;
  const units = draft.unit || getUnits();
  draft.unit = units;
  let previous = {};
  let timer = 0;
  let dirty = false;
  let saving = false;
  holdReload(HOLD);

  const persist = () => {
    dirty = true;
    if (mode === 'active') writeActive(draft);
  };

  // ---- chrome
  const primary = navButton({ label: mode === 'active' ? 'Finish' : 'Save', primary: true, onClick: () => save() });
  primary.classList.add('wo-finish');
  const bar = navbar({
    title: mode === 'active' ? 'Log Workout' : mode === 'edit' ? 'Edit Workout' : (draft.id ? 'Edit Routine' : 'New Routine'),
    back: true,
    right: [primary],
    onBack: () => leave(),
  });
  const titleInput = el('input', {
    class: 'wo-title-input', type: 'text', value: draft.title || '', maxlength: '100',
    placeholder: mode === 'routine' ? 'Routine name' : 'Workout title', 'aria-label': mode === 'routine' ? 'Routine name' : 'Workout title',
    autocapitalize: 'words', enterkeyhint: 'done',
  });
  titleInput.addEventListener('input', () => { draft.title = titleInput.value; persist(); });
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleInput.blur(); });

  let plan;
  if (mode === 'routine') {
    const description = el('textarea', {
      class: 'input wo-plan-notes', rows: '3', maxlength: '4000', text: draft.notes || '',
      placeholder: 'Warm-up, focus and other instructions', 'aria-label': 'Routine instructions',
    });
    description.addEventListener('input', () => { draft.notes = description.value; persist(); });
    const days = el('div', { class: 'wo-weekdays', role: 'group', 'aria-label': 'Scheduled days' });
    const drawDays = () => {
      days.replaceChildren(...WEEKDAYS.map(([day, label]) => el('button', {
        type: 'button', class: 'chip wo-weekday', text: label,
        'aria-pressed': String((draft.weekdays || []).includes(day)),
        'on:click': () => {
          const selected = new Set(draft.weekdays || []);
          if (selected.has(day)) selected.delete(day); else selected.add(day);
          draft.weekdays = [...selected].sort((a, b) => a - b);
          persist();
          drawDays();
        },
      })));
    };
    drawDays();
    plan = el('div', { class: 'wo-routine-details' },
      description,
      el('div', { class: 'wo-schedule-label', text: 'Scheduled days' }), days,
      el('div', { class: 'muted wo-schedule-hint', text: 'Choose days to show this routine in your daily plan.' }),
      sourceLink(draft.source_url));
  } else if (draft.notes || draft.source_url) {
    plan = el('div', { class: 'card wo-routine-details' },
      draft.notes ? el('div', { class: 'wo-plan-notes', text: draft.notes }) : null,
      sourceLink(draft.source_url));
  }

  const statDuration = el('span', { class: 'wo-stat-v' });
  const statVolume = el('span', { class: 'wo-stat-v' });
  const statSets = el('span', { class: 'wo-stat-v' });
  const stats = mode === 'routine' ? null : el('div', { class: 'wo-stats' },
    el('div', null, el('span', { class: 'wo-stat-k', text: 'Duration' }), statDuration),
    el('div', null, el('span', { class: 'wo-stat-k', text: 'Volume' }), statVolume),
    el('div', null, el('span', { class: 'wo-stat-k', text: 'Sets' }), statSets));

  const list = el('div', { class: 'wo-exercises' });
  const empty = el('div', { class: 'wo-log-empty' },
    el('div', { class: 'wo-log-empty-title', text: mode === 'routine' ? 'No exercises yet' : 'Get started' }),
    el('div', { class: 'muted', text: 'Add an exercise to start logging sets.' }));
  const addEx = el('button', { type: 'button', class: 'wo-btn wo-btn-primary', 'on:click': addExercises }, icon('plus', { size: 20 }), el('span', { text: 'Add Exercise' }));
  const tail = [addEx];
  if (mode === 'active') {
    tail.push(el('button', { type: 'button', class: 'wo-btn wo-btn-danger', text: 'Discard Workout', 'on:click': discard }));
  }

  const restBar = el('div', { class: 'wo-rest', hidden: true });
  const restFill = el('div', { class: 'wo-rest-fill' });
  const restTime = el('div', { class: 'wo-rest-time' });
  restBar.append(
    el('div', { class: 'wo-rest-track' }, restFill),
    el('div', { class: 'wo-rest-row' },
      el('button', { type: 'button', class: 'wo-rest-btn', text: '−15', 'aria-label': 'Take 15 seconds off', 'on:click': () => bumpRest(-15) }),
      restTime,
      el('button', { type: 'button', class: 'wo-rest-btn', text: '+15', 'aria-label': 'Add 15 seconds', 'on:click': () => bumpRest(15) }),
      el('button', { type: 'button', class: 'wo-rest-btn wo-rest-skip', text: 'Skip', 'on:click': () => stopRest() })));

  const content = el('div', { class: 'app-content wo-log' }, titleInput, stats, plan, list, empty, ...tail);
  root.append(bar, content, restBar);

  render();
  loadPrevious();
  timer = setInterval(tick, 250);
  tick();

  // ---- rendering

  function render() {
    list.replaceChildren(...draft.exercises.map(exerciseCard));
    empty.hidden = draft.exercises.length > 0;
    updateStats();
  }

  function columns(kind, exerciseDistanceUnit) {
    if (kind === 'weight') return [['w', units, 'decimal'], ['r', 'Reps', 'numeric']];
    if (kind === 'reps') return [['r', 'Reps', 'numeric']];
    if (kind === 'time') return [['t', 'Time', 'numeric']];
    return [['d', distanceUnit(exerciseDistanceUnit, units), 'decimal'], ['t', 'Time', 'numeric']];
  }

  function exerciseCard(ex) {
    const cols = columns(ex.kind, ex.distance_unit);
    const labels = setLabels(ex.sets);
    const prev = previous[ex.exercise_id] || [];
    const grid = `wo-grid-${cols.length}${mode === 'routine' ? ' no-check' : ''}`;
    const head = el('div', { class: `wo-set-head ${grid}` },
      el('span', { text: 'Set' }), el('span', { text: 'Previous' }),
      ...cols.map(([, label]) => el('span', { text: label })),
      mode === 'routine' ? null : el('span', { class: 'wo-head-check' }, icon('check', { size: 16, strokeWidth: 2.4 })));
    const rows = ex.sets.map((s, i) => setRow(ex, s, i, labels[i], prev[i], cols, grid));
    const restLabel = ex.rest ? `Rest ${fmtClock(ex.rest)}` : 'Rest off';
    const note = el('textarea', {
      class: 'wo-note', rows: ex.note?.includes('\n') ? '3' : '1', text: ex.note || '', placeholder: 'Add notes here…', maxlength: mode === 'routine' ? '1000' : '7000', 'aria-label': `Notes for ${ex.name}`,
    });
    note.addEventListener('input', () => { ex.note = note.value; persist(); });
    let prescription;
    if (mode === 'routine') {
      prescription = el('textarea', {
        class: 'input wo-prescription-input', rows: '2', maxlength: '2000', text: ex.prescription || '',
        placeholder: 'Targets, e.g. 3 × 8–12 reps · 2 reps in reserve', 'aria-label': `Prescription for ${ex.name}`,
      });
      prescription.addEventListener('input', () => { ex.prescription = prescription.value; persist(); });
    } else if (ex.prescription) {
      prescription = el('div', { class: 'wo-prescription', text: ex.prescription });
    }
    return el('section', { class: 'wo-ex card', dataset: { uid: ex.uid } },
      el('div', { class: 'wo-ex-head' },
        el('button', { type: 'button', class: 'wo-ex-name', text: ex.name, 'on:click': () => exerciseMenu(ex) }),
        el('button', { type: 'button', class: 'wo-ex-more', 'aria-label': `Options for ${ex.name}`, 'on:click': () => exerciseMenu(ex) }, icon('more'))),
      prescription, note,
      el('button', { type: 'button', class: 'wo-rest-chip', 'on:click': () => pickRest(ex) }, icon('refresh', { size: 15, strokeWidth: 2.2 }), el('span', { text: restLabel })),
      head,
      ...rows,
      el('button', { type: 'button', class: 'wo-add-set', 'on:click': () => addSet(ex) }, icon('plus', { size: 18 }), el('span', { text: 'Add Set' })));
  }

  function setRow(ex, s, i, label, prev, cols, grid) {
    const row = el('div', { class: `wo-set ${grid}${s.done ? ' done' : ''}`, dataset: { uid: s.uid } });
    const kindBtn = el('button', {
      type: 'button', class: `wo-set-label k-${s.kind}`, text: label, 'aria-label': `Set ${label}: ${SET_KIND_LABELS[s.kind]}. Change type or delete`,
      'on:click': () => setMenu(ex, s),
    });
    const prevText = prev ? setText(ex.kind, prev, ex.distance_unit) : '—';
    const prevBtn = el('button', {
      type: 'button', class: 'wo-prev', text: prevText, disabled: !prev, 'aria-label': prev ? `Previous: ${prevText}. Tap to copy` : 'No previous',
      'on:click': () => { if (prev) { fillFrom(s, prev, true, ex.distance_unit); haptic('light'); render(); persist(); } },
    });
    const ph = prev ? draftSet(prev, false, ex.distance_unit) : null;
    const inputs = cols.map(([key, label, mode_]) => {
      const input = el('input', {
        class: 'wo-in', type: 'text', inputmode: mode_, value: s[key], placeholder: ph && ph[key] ? ph[key] : (key === 't' ? '0:00' : '–'),
        'aria-label': `${label}, set ${i + 1}`, autocomplete: 'off', enterkeyhint: 'next',
      });
      input.addEventListener('input', () => {
        if (key === 't') {
          input.value = digitsToClock(input.value);
        } else {
          const clean = input.value.replace(',', '.').replace(mode_ === 'numeric' ? /[^\d]/g : /[^\d.]/g, '');
          if (clean !== input.value) input.value = clean;
        }
        s[key] = input.value;
        persist();
        updateStats();
      });
      input.addEventListener('focus', () => input.select());
      return input;
    });
    row.append(kindBtn, prevBtn, ...inputs);
    if (mode !== 'routine') {
      row.append(el('button', {
        type: 'button', class: 'wo-check', role: 'checkbox', 'aria-checked': String(s.done), 'aria-label': `Set ${label} done`,
        'on:click': () => toggleDone(ex, s, ph),
      }, icon('check', { size: 18, strokeWidth: 2.8 })));
    }
    return row;
  }

  function fillDraftValues(s, source, overwrite) {
    for (const key of ['w', 'r', 't', 'd']) if (overwrite || !s[key]) {
      s[key] = source[key];
      if (key === 'd') for (const extra of ['d_source', 'd_unit_source', 'meters_source']) s[extra] = source[extra];
    }
  }

  function fillFrom(s, prev, overwrite, exerciseDistanceUnit) {
    fillDraftValues(s, draftSet(prev, false, exerciseDistanceUnit), overwrite);
  }

  function toggleDone(ex, s, ph) {
    if (!s.done) {
      if (ph) fillDraftValues(s, ph, false);
      if (!serverSet(ex.kind, s, units, ex.distance_unit)) {
        toast(ex.kind === 'time' ? 'Enter a time first' : ex.kind === 'cardio' ? 'Enter a distance or time first' : 'Enter reps first', { kind: 'error' });
        haptic('error');
        return;
      }
      s.done = true;
      haptic('success');
      if (mode === 'active' && ex.rest) startRest(ex.rest);
    } else {
      s.done = false;
      haptic('light');
    }
    persist();
    // Re-render just this card so filled-in values show without losing other focus.
    const card = list.querySelector(`[data-uid="${ex.uid}"]`);
    if (card) card.replaceWith(exerciseCard(ex));
    updateStats();
  }

  function updateStats() {
    if (!stats) return;
    let vol = 0;
    let sets = 0;
    for (const ex of draft.exercises) {
      for (const s of ex.sets) {
        if (!s.done) continue;
        sets += 1;
        if (ex.kind === 'weight') vol += (Number(s.w) || 0) * (Number(s.r) || 0);
      }
    }
    statVolume.textContent = `${Math.round(vol).toLocaleString()} ${units}`;
    statSets.textContent = String(sets);
    tick();
  }

  function tick() {
    if (stats) {
      statDuration.textContent = mode === 'active'
        ? fmtClock((Date.now() - Date.parse(draft.started_at)) / 1000)
        : fmtLong((Date.parse(draft.ended_at) - Date.parse(draft.started_at)) / 1000);
    }
    if (draft.rest_end) {
      const left = Math.ceil((draft.rest_end - Date.now()) / 1000);
      if (left <= 0) {
        stopRest();
        haptic('success');
        toast('Rest over — next set');
        return;
      }
      restBar.hidden = false;
      restTime.textContent = fmtClock(left);
      restFill.style.width = `${Math.max(0, Math.min(100, (left / (draft.rest_total || left)) * 100))}%`;
    } else {
      restBar.hidden = true;
    }
  }

  // ---- rest timer

  function startRest(seconds) {
    draft.rest_end = Date.now() + seconds * 1000;
    draft.rest_total = seconds;
    persist();
    tick();
  }
  function bumpRest(delta) {
    if (!draft.rest_end) return;
    draft.rest_end += delta * 1000;
    draft.rest_total = Math.max(1, (draft.rest_total || 0) + delta);
    haptic('light');
    persist();
    tick();
  }
  function stopRest() {
    draft.rest_end = null;
    draft.rest_total = null;
    persist();
    restBar.hidden = true;
  }

  async function pickRest(ex) {
    const choice = await actionSheet({
      title: 'Rest timer',
      message: ex.name,
      actions: REST_CHOICES.map((sec) => ({ label: sec ? fmtClock(sec) : 'Off', value: sec, selected: (ex.rest || 0) === sec })),
    });
    if (choice === null) return;
    ex.rest = choice;
    persist();
    render();
  }

  // ---- exercises and sets

  async function loadPrevious(ids = draft.exercises.map((e) => e.exercise_id)) {
    const want = [...new Set(ids)].filter((id) => !(id in previous));
    if (!want.length) return;
    try {
      const q = `ids=${want.join(',')}${mode === 'edit' && draft.id ? `&exclude=${draft.id}` : ''}`;
      const data = await api(`/api/workout/previous?${q}`);
      Object.assign(previous, data.previous || {});
      render();
    } catch { /* the column just stays empty */ }
  }

  async function addExercises() {
    const picked = await pickExercises({ title: 'Add exercises' });
    if (!picked.length) return;
    for (const ex of picked) draft.exercises.push(draftExercise(ex, [blankSet()]));
    persist();
    render();
    await loadPrevious(picked.map((e) => e.id));
    // Start the new exercise with as many sets as last time.
    for (const ex of draft.exercises.slice(-picked.length)) {
      const prev = previous[ex.exercise_id] || [];
      if (prev.length > 1 && ex.sets.length === 1 && !ex.sets[0].done && !ex.sets[0].w && !ex.sets[0].r) {
        ex.sets = prev.map((p) => blankSet(p.kind));
      }
    }
    persist();
    render();
    const last = list.lastElementChild;
    if (last) last.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function addSet(ex) {
    const last = ex.sets[ex.sets.length - 1];
    const s = blankSet();
    if (last) fillDraftValues(s, last, true);
    ex.sets.push(s);
    haptic('light');
    persist();
    const card = list.querySelector(`[data-uid="${ex.uid}"]`);
    if (card) card.replaceWith(exerciseCard(ex));
    updateStats();
  }

  async function setMenu(ex, s) {
    const actions = Object.entries(SET_KIND_LABELS).map(([value, label]) => ({ label, value, selected: s.kind === value }));
    actions.push({ label: 'Delete Set', value: 'delete', destructive: true });
    const choice = await actionSheet({ title: 'Set type', actions });
    if (choice === null) return;
    if (choice === 'delete') {
      ex.sets = ex.sets.filter((x) => x !== s);
    } else {
      s.kind = choice;
    }
    persist();
    render();
  }

  async function exerciseMenu(ex) {
    const i = draft.exercises.indexOf(ex);
    // History leaves the logger, which only the active workout (kept in storage) survives.
    const actions = mode === 'active' ? [{ label: 'Exercise History', value: 'history' }] : [];
    actions.push({ label: 'Replace Exercise', value: 'replace' });
    if (ex.kind === 'cardio') actions.push({ label: 'Distance Unit', value: 'distance_unit' });
    if (i > 0) actions.push({ label: 'Move Up', value: 'up' });
    if (i < draft.exercises.length - 1) actions.push({ label: 'Move Down', value: 'down' });
    actions.push({ label: 'Remove Exercise', value: 'remove', destructive: true });
    const choice = await actionSheet({ title: ex.name, actions });
    if (choice === 'history') {
      ctx.nav.go(`#/workout/e/${ex.exercise_id}`);
      return;
    }
    if (choice === 'distance_unit') {
      const nextUnit = await actionSheet({ title: 'Distance unit', actions: [
        { label: 'Default', value: '', selected: !ex.distance_unit },
        ...[['m', 'Meters'], ['yd', 'Yards'], ['km', 'Kilometers'], ['mi', 'Miles']].map(([value, label]) => ({ label, value, selected: ex.distance_unit === value })),
      ] });
      if (nextUnit === null) return;
      for (const s of ex.sets) {
        const value = serverSet(ex.kind, s, units, ex.distance_unit);
        if (value) {
          const converted = draftSet(value, s.done, nextUnit);
          for (const key of ['d', 'd_source', 'd_unit_source', 'meters_source']) s[key] = converted[key];
        }
      }
      ex.distance_unit = nextUnit;
      persist();
      render();
      return;
    }
    if (choice === 'replace') {
      const [next] = await pickExercises({ title: 'Replace exercise', single: true });
      if (!next) return;
      const fresh = draftExercise(next, ex.sets.map((s) => ({ ...blankSet(s.kind) })), ex.rest);
      fresh.uid = ex.uid;
      draft.exercises[draft.exercises.indexOf(ex)] = fresh;
      await loadPrevious([next.id]);
    } else if (choice === 'up' || choice === 'down') {
      const j = choice === 'up' ? i - 1 : i + 1;
      [draft.exercises[i], draft.exercises[j]] = [draft.exercises[j], draft.exercises[i]];
    } else if (choice === 'remove') {
      const logged = ex.sets.some((s) => s.done);
      if (logged && !(await confirmSheet({ title: `Remove ${ex.name}?`, message: 'Its logged sets go too.', confirmLabel: 'Remove', destructive: true }))) return;
      draft.exercises = draft.exercises.filter((x) => x !== ex);
    } else {
      return;
    }
    persist();
    render();
  }

  // ---- leaving, saving

  async function leave() {
    // The workout keeps running: back drops to the Workout tab (Hevy's "minimise").
    if (mode === 'active') return exit('#/workout');
    if (!dirty) return exit();
    const ok = await confirmSheet({ title: 'Discard changes?', message: 'What you changed here will not be saved.', confirmLabel: 'Discard', destructive: true });
    if (ok) exit();
  }

  function exit(hash) {
    cleanup();
    if (onDone) onDone();
    if (hash) nav.replace(hash);
    else ctx.nav.back();
  }

  async function discard() {
    const ok = await confirmSheet({ title: 'Discard this workout?', message: 'Nothing from it will be saved.', confirmLabel: 'Discard Workout', destructive: true });
    if (!ok) return;
    await clearActive();
    haptic('light');
    exit('#/workout');
  }

  function payloadExercises({ onlyDone }) {
    const out = [];
    for (const ex of draft.exercises) {
      const sets = [];
      for (const s of ex.sets) {
        if (onlyDone && !s.done) continue;
        const v = serverSet(ex.kind, s, units, ex.distance_unit);
        if (v) sets.push(v);
        else if (!onlyDone) sets.push({ kind: s.kind });
      }
      if (onlyDone && !sets.length) continue;
      out.push({ exercise_id: ex.exercise_id, note: (ex.note || '').trim(), prescription: ex.prescription || '', distance_unit: ex.distance_unit || '', rest: ex.rest ?? null, sets });
    }
    return out;
  }

  async function save() {
    if (saving) return;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (mode === 'routine') return saveRoutine();
    // Sets that have numbers but no checkmark: ask what to do with them.
    const unfinished = draft.exercises.flatMap((ex) => ex.sets.filter((s) => !s.done && serverSet(ex.kind, s, units, ex.distance_unit)));
    if (unfinished.length) {
      const choice = await actionSheet({
        title: `${unfinished.length} set${unfinished.length === 1 ? ' is' : 's are'} not checked off`,
        actions: [{ label: 'Complete Unfinished Sets', value: 'complete' }, { label: 'Discard Unfinished Sets', value: 'drop', destructive: true }],
      });
      if (choice === null) return;
      if (choice === 'complete') unfinished.forEach((s) => { s.done = true; });
      persist();
      render();
    }
    const exercises = payloadExercises({ onlyDone: true });
    if (!exercises.length) {
      toast('Check off at least one set first', { kind: 'error' });
      haptic('error');
      return;
    }
    let advanceProgram;
    if (mode === 'active' && draft.program && hasRemainingProgramSets(draft)) {
      const choice = await actionSheet({
        title: 'Some planned sets remain',
        message: 'Save a partial workout to keep this routine up next, or finish it and move to the next workout.',
        actions: [{ label: 'Save Partial Workout', value: 'partial' }, { label: 'Finish and Move On', value: 'advance' }],
      });
      if (choice === null) return;
      advanceProgram = choice === 'advance';
    }
    const fields = [
      { key: 'title', label: 'Title', value: draft.title || defaultTitle(new Date(draft.started_at)), required: true },
      { key: 'notes', label: 'Description', type: 'textarea', value: draft.notes || '', placeholder: 'How did it go?' },
    ];
    const endMs = mode === 'active' ? Date.now() : Date.parse(draft.ended_at);
    if (mode === 'edit') {
      fields.push({ key: 'minutes', label: 'Duration (minutes)', type: 'number', value: String(Math.max(1, Math.round((endMs - Date.parse(draft.started_at)) / 60000))) });
    }
    const result = await formSheet({ title: mode === 'active' ? 'Save Workout' : 'Save Changes', saveLabel: 'Save', fields });
    if (!result || result === 'delete') return;
    draft.title = result.title;
    draft.notes = result.notes;
    titleInput.value = result.title;
    let ended = new Date(endMs).toISOString();
    if (mode === 'edit' && Number.isFinite(result.minutes) && result.minutes > 0) {
      ended = new Date(Date.parse(draft.started_at) + Math.min(result.minutes, 24 * 60) * 60000).toISOString();
    }
    const body = {
      title: result.title, notes: result.notes, started_at: draft.started_at, ended_at: ended,
      routine_id: draft.routine_id || null, exercises,
      advance_program: advanceProgram,
    };
    saving = true;
    primary.disabled = true;
    try {
      const url = mode === 'edit' ? `/api/workout/sessions/${draft.id}` : '/api/workout/sessions';
      const { session } = await api(url, { method: mode === 'edit' ? 'PUT' : 'POST', body, timeout: 20000 });
      if (mode === 'active') await clearActive();
      haptic('success');
      exit(mode === 'active' ? `#/workout/s/${session.id}/new` : `#/workout/s/${session.id}`);
    } catch (err) {
      saving = false;
      primary.disabled = false;
      toast(err && err.status ? `Couldn't save: ${err.message}` : "Couldn't save — the PC is unreachable. Your workout is kept here.", { kind: 'error', ms: 3500 });
      haptic('error');
    }
  }

  async function saveRoutine() {
    const name = (draft.title || '').trim();
    if (!name) {
      toast('Give the routine a name', { kind: 'error' });
      titleInput.focus();
      return;
    }
    if (!draft.exercises.length) {
      toast('Add at least one exercise', { kind: 'error' });
      return;
    }
    saving = true;
    primary.disabled = true;
    try {
      const body = {
        name, notes: draft.notes || '', weekdays: draft.weekdays || [],
        source_id: draft.source_id || '', source_url: draft.source_url || '',
        exercises: payloadExercises({ onlyDone: false }),
      };
      await api(draft.id ? `/api/workout/routines/${draft.id}` : '/api/workout/routines', { method: draft.id ? 'PUT' : 'POST', body });
      haptic('success');
      toast(draft.id ? 'Routine saved' : 'Routine created');
      exit('#/workout');
    } catch (err) {
      saving = false;
      primary.disabled = false;
      toast(err && err.status ? `Couldn't save: ${err.message}` : "Couldn't save — the PC is unreachable", { kind: 'error' });
      haptic('error');
    }
  }

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearInterval(timer);
    releaseReload(HOLD);
  }
  return cleanup;
}

// ---- builders for the three modes

export function newActiveDraft({ title = '', routine = null, program = false } = {}) {
  const now = new Date();
  return {
    mode: 'active',
    title: title || (routine ? routine.name : defaultTitle(now)),
    started_at: now.toISOString(),
    unit: getUnits(),
    routine_id: routine ? routine.id : null,
    program: Boolean(program),
    planned_exercises: routine ? routine.exercises.map((ex) => ({ exercise_id: ex.exercise_id, sets: Math.max(1, ex.sets.length) })) : [],
    notes: routine?.notes || '',
    source_id: routine?.source_id || '',
    source_url: routine?.source_url || '',
    rest_end: null,
    exercises: routine
      ? routine.exercises.map((ex) => draftExercise(ex, (ex.sets.length ? ex.sets : [{ kind: 'normal' }]).map((s) => draftSet(s, false, ex.distance_unit)), ex.rest ?? 0))
      : [],
  };
}

export function draftFromSession(session, mode = 'edit') {
  return {
    mode,
    id: mode === 'edit' ? session.id : null,
    title: session.title,
    started_at: mode === 'edit' ? session.started_at : new Date().toISOString(),
    ended_at: session.ended_at,
    unit: getUnits(),
    routine_id: session.routine_id,
    notes: mode === 'active' ? '' : session.notes,
    exercises: session.exercises.map((ex) => draftExercise(ex, ex.sets.map((s) => draftSet(s, mode === 'edit', ex.distance_unit)), ex.rest ?? 0)),
  };
}

export function draftFromRoutine(routine) {
  return {
    mode: 'routine',
    id: routine ? routine.id : null,
    title: routine ? routine.name : '',
    notes: routine?.notes || '',
    weekdays: [...(routine?.weekdays || [])],
    source_id: routine?.source_id || '',
    source_url: routine?.source_url || '',
    started_at: new Date().toISOString(),
    unit: getUnits(),
    exercises: routine ? routine.exercises.map((ex) => draftExercise(ex, (ex.sets.length ? ex.sets : [{ kind: 'normal' }]).map((s) => draftSet(s, false, ex.distance_unit)), ex.rest ?? 0)) : [],
  };
}

export { uid };
