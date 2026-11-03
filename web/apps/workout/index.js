// Workout app — a Hevy-style gym log. Routes (sub of #/workout/…):
//   ''            Workout tab: resume / start empty / routines (start, edit, delete), units
//   history       History tab: workouts-per-week chart + every workout, newest first
//   exercises     Exercises tab: the library with search + muscle filter, custom exercises
//   active        the workout in progress (logger.js)
//   s/<id>        a saved workout ('s/<id>/new' = just finished, shows records); s/<id>/edit
//   r/new, r/<id> routine editor
//   e/<id>        one exercise: chart, records, history
// Data: /api/workout/* (server/apps/workout.js).
import * as kit from '../../kit.js';
import { formSheet } from '../../form.js';
import { barChart, lineChart } from './charts.js';
import { mountLogger, newActiveDraft, draftFromSession, draftFromRoutine } from './logger.js';
import { createExercise } from './picker.js';
import { programView } from './program.js';
import {
  getUnits, setUnits, loadUnits, fmtVolume, fmtLong, fmtClock, fmtWeight, fmtDist, distUnit, setText, setLabels,
  e1rm, PR_LABELS, prValue, loadLibrary, cachedLibrary, MUSCLES, EQUIPMENT, KIND_LABELS,
  readActive, writeActive, clearActive, syncActive,
} from './lib.js';

const { api, el, fmt, toast, haptic, navbar, navButton, section, emptyState, icon, confirmSheet, actionSheet, nav, store } = kit;

let root = null;
let ctx = null;
let cleanupView = null;
let seq = 0;
let listeners = [];
let exQuery = { q: '', muscle: '' };

export default {
  mount(r, c) {
    root = r;
    ctx = c;
    loadUnits();
    show(c.sub || '');
    const refresh = () => { if (currentSub === '' || currentSub === 'history') show(currentSub); };
    listen(window, 'jakesdata:foreground', refresh);
    listen(window, 'jakesdata:online', refresh);
  },
  route(sub) { show(sub || ''); },
  unmount() {
    teardown();
    for (const [t, type, fn] of listeners) t.removeEventListener(type, fn);
    listeners = [];
    root = null;
    ctx = null;
  },
};

let currentSub = '';

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  listeners.push([target, type, fn]);
}

function teardown() {
  seq += 1;
  if (cleanupView) {
    try { cleanupView(); } catch { /* ignore */ }
  }
  cleanupView = null;
  if (root) root.replaceChildren();
}

function show(sub) {
  if (!root) return;
  teardown();
  currentSub = sub;
  const parts = sub.split('/').filter(Boolean);
  const token = seq;
  const alive = () => token === seq && root;
  window.scrollTo(0, 0);
  if (!parts.length || parts[0] === 'history' || parts[0] === 'exercises') return tabs(parts[0] || 'workout', alive);
  if (parts[0] === 'active') return activeView(alive);
  if (parts[0] === 's' && parts[1]) return parts[2] === 'edit' ? editView(Number(parts[1]), alive) : sessionView(Number(parts[1]), parts[2] === 'new', alive);
  if (parts[0] === 'r' && parts[1]) return routineView(parts[1] === 'new' ? null : Number(parts[1]), alive);
  if (parts[0] === 'e' && parts[1]) return exerciseView(Number(parts[1]), alive);
  nav.replace('#/workout');
}

const errText = (err, verb = 'load') => (err && err.status ? `Couldn't ${verb}: ${err.message}` : `Couldn't ${verb} — the PC is unreachable`);
const loading = () => el('div', { class: 'wo-loading muted', text: 'Loading…' });

// ---------------------------------------------------------------- tabs

function tabs(tab, alive) {
  const right = [];
  if (tab === 'exercises') right.push(navButton({ icon: 'plus', label: 'New exercise', onClick: async () => { const ex = await createExercise(); if (ex) ctx.nav.go(`#/workout/e/${ex.id}`); } }));
  const seg = el('div', { class: 'segmented wo-tabs', role: 'tablist' },
    ...[['workout', 'Workout', '#/workout'], ['history', 'History', '#/workout/history'], ['exercises', 'Exercises', '#/workout/exercises']]
      .map(([id, label, hash]) => el('button', {
        type: 'button', text: label, role: 'tab', 'aria-pressed': String(tab === id), 'aria-selected': String(tab === id),
        'on:click': () => { if (tab !== id) { haptic('light'); nav.replace(hash); } },
      })));
  const body = el('div', { class: 'wo-tab-body' }, loading());
  root.append(navbar({ title: 'Workout', right }), el('div', { class: 'app-content' }, seg, body));
  if (tab === 'workout') workoutTab(body, alive);
  else if (tab === 'history') historyTab(body, alive);
  else exercisesTab(body, alive);
}

// ---- Workout tab

async function startWorkout(draft) {
  const existing = readActive();
  if (existing) {
    const choice = await actionSheet({
      title: 'You have a workout in progress',
      message: existing.title || 'Workout',
      actions: [{ label: 'Resume It', value: 'resume' }, { label: 'Discard It and Start New', value: 'new', destructive: true }],
    });
    if (choice === null) return;
    if (choice === 'resume') return ctx.nav.go('#/workout/active');
    await clearActive();
  }
  writeActive(draft);
  haptic('success');
  ctx.nav.go('#/workout/active');
}

async function workoutTab(body, alive) {
  let active = readActive();
  let routines = null;
  let sessions = [];
  let program = null;
  let previewIndex = null;
  let selectedDay = fmt.dayKey();
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const draw = () => {
    if (!alive()) return;
    const out = [];
    if (active) {
      const done = active.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done).length, 0);
      out.push(el('button', { type: 'button', class: 'card wo-active-card', 'on:click': () => ctx.nav.go('#/workout/active') },
        el('span', { class: 'wo-live-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'wo-active-text' },
          el('span', { class: 'wo-active-title', text: 'Workout in progress' }),
          el('span', { class: 'muted', text: `${active.title || 'Workout'} · ${fmtLong((Date.now() - Date.parse(active.started_at)) / 1000)} · ${done} set${done === 1 ? '' : 's'}` })),
        el('span', { class: 'wo-resume', text: 'Resume' })));
    }
    if (program && routines) out.push(programView({
      program, routines, active, previewIndex, nav: ctx.nav,
      onPreview: (index) => { previewIndex = index; draw(); },
      onChange: (updated) => { program = updated; draw(); },
      onStart: (routine) => startWorkout(newActiveDraft({ routine, program: true })),
    }));
    else if (routines?.some((r) => r.weekdays?.length)) out.push(todayPlan());
    if (!active) out.push(el('button', { type: 'button', class: 'wo-btn wo-btn-secondary', 'on:click': () => startWorkout(newActiveDraft()) },
      icon('plus', { size: 20 }), el('span', { text: 'Start Empty Workout' })));
    out.push(el('div', { class: 'wo-section-row' }, section('Routines'),
      el('button', { type: 'button', class: 'wo-link', text: 'New Routine', 'on:click': () => ctx.nav.go('#/workout/r/new') })));
    if (routines === null) out.push(loading());
    else if (!routines.length) out.push(emptyState('No routines yet. Save a workout as a routine, or tap New Routine.'));
    else {
      const otherRoutines = routines.filter((r) => !program?.routine_ids.includes(r.id));
      out.push(...otherRoutines.map(routineCard));
      if (!otherRoutines.length && program) out.push(el('p', { class: 'muted wo-plan-note', text: 'All program workouts are available in the selector above.' }));
    }
    out.push(section('Units'), el('div', { class: 'card wo-units' },
      el('span', { text: 'Weight' }),
      el('div', { class: 'segmented' }, ...['lb', 'kg'].map((u) => el('button', {
        type: 'button', text: u, 'aria-pressed': String(getUnits() === u),
        'on:click': async () => { await setUnits(u); draw(); },
      })))));
    body.replaceChildren(...out);
  };

  function todayPlan() {
    const today = new Date();
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7), 12);
    const selected = new Date(`${selectedDay}T12:00:00`);
    const planned = routines.filter((r) => r.weekdays?.includes(selected.getDay()));
    const week = el('div', { class: 'wo-week', role: 'group', 'aria-label': 'Training days this week' },
      ...Array.from({ length: 7 }, (_, i) => {
        const date = new Date(monday); date.setDate(date.getDate() + i);
        const key = fmt.dayKey(date);
        const scheduled = routines.some((r) => r.weekdays?.includes(date.getDay()));
        return el('button', {
          type: 'button', class: `wo-day${scheduled ? ' scheduled' : ''}${key === fmt.dayKey(today) ? ' today' : ''}`,
          'aria-pressed': String(key === selectedDay), 'aria-label': `${fmt.date(date, { weekday: 'long' })}${scheduled ? ', workout scheduled' : ', no workout scheduled'}`,
          'on:click': () => { selectedDay = key; draw(); },
        }, el('span', { text: weekdayNames[date.getDay()] }), el('strong', { text: String(date.getDate()) }), el('span', { class: 'wo-day-dot', 'aria-hidden': 'true' }));
      }));
    const cards = planned.map((routine) => {
      const completed = sessions.find((s) => s.routine_id === routine.id && fmt.dayKey(s.started_at) === selectedDay);
      const inProgress = active?.routine_id === routine.id;
      return el('section', { class: 'card wo-plan' },
        el('div', { class: 'wo-plan-heading' },
          el('h2', { text: routine.name }),
          completed ? el('span', { class: 'wo-plan-complete', text: 'Complete' }) : null),
        el('div', { class: 'muted wo-plan-meta', text: `${routine.exercises.length} exercises · ${routine.exercises.reduce((n, e) => n + e.sets.length, 0)} sets` }),
        routine.notes ? el('details', { class: 'wo-program-notes' }, el('summary', { text: 'Program notes' }), el('p', { text: routine.notes })) : null,
        el('ol', { class: 'wo-plan-exercises' }, ...routine.exercises.map((ex) =>
          el('li', {}, el('div', { class: 'wo-plan-ex-name', text: ex.name }),
            el('div', { class: 'wo-plan-prescription', text: ex.prescription || targetSummary(ex) }),
            ex.note ? el('div', { class: 'muted wo-plan-note', text: ex.note }) : null,
            ex.rest ? el('div', { class: 'muted wo-plan-rest', text: `Rest ${fmtClock(ex.rest)}` }) : null))),
        el('button', {
          type: 'button', class: 'wo-btn wo-btn-primary',
          text: inProgress ? 'Resume Workout' : completed ? 'View Completed Workout' : 'Start Workout',
          'on:click': () => inProgress ? ctx.nav.go('#/workout/active') : completed ? ctx.nav.go(`#/workout/s/${completed.id}`) : startWorkout(newActiveDraft({ routine })),
        }),
        routine.source_url ? el('a', { class: 'wo-plan-source', href: routine.source_url, target: '_blank', rel: 'noopener noreferrer', text: 'Original plan in Notion' }) : null);
    });
    return el('div', { class: 'wo-daily-plan' },
      el('div', { class: 'wo-section-row' }, section(selectedDay === fmt.dayKey(today) ? 'Today’s plan' : fmt.date(selected, { weekday: 'long' })),
        selectedDay !== fmt.dayKey(today) ? el('button', { type: 'button', class: 'wo-link', text: 'Today', 'on:click': () => { selectedDay = fmt.dayKey(); draw(); } }) : null),
      week,
      ...(cards.length ? cards : [el('div', { class: 'card wo-plan' }, el('h2', { text: 'No workout scheduled' }), el('p', { class: 'muted', text: 'Your other routines are below.' }))]));
  }

  function targetSummary(ex) {
    if (!ex.sets.length) return 'No target sets';
    const targets = ex.sets.map((s) => [s.weight_kg, s.reps, s.seconds, s.meters].some((v) => v != null) ? setText(ex.kind, s, ex.distance_unit) : 'Log your set');
    return targets.every((s) => s === targets[0]) ? `${targets.length} × ${targets[0]}` : targets.map((s, i) => `${i + 1}: ${s}`).join(' · ');
  }

  function routineCard(r) {
    return el('div', { class: 'card wo-routine' },
      el('div', { class: 'wo-routine-head' },
        el('div', { class: 'wo-routine-name', text: r.name }),
        el('button', { type: 'button', class: 'wo-ex-more', 'aria-label': `Options for ${r.name}`, 'on:click': () => routineMenu(r) }, icon('more'))),
      r.weekdays?.length ? el('div', { class: 'wo-routine-days', text: r.weekdays.map((d) => weekdayNames[d]).join(' · ') }) : null,
      el('div', { class: 'wo-routine-list muted', text: r.exercises.map((e) => e.name).join(', ') || 'No exercises' }),
      el('button', { type: 'button', class: 'wo-btn wo-btn-primary wo-btn-small', text: 'Start Routine', 'on:click': () => startWorkout(newActiveDraft({ routine: r })) }));
  }

  async function routineMenu(r) {
    const choice = await actionSheet({ title: r.name, actions: [{ label: 'Edit Routine', value: 'edit' }, { label: 'Delete Routine', value: 'delete', destructive: true }] });
    if (choice === 'edit') ctx.nav.go(`#/workout/r/${r.id}`);
    if (choice === 'delete') {
      if (!(await confirmSheet({ title: `Delete ${r.name}?`, message: 'Workouts you logged with it stay.', confirmLabel: 'Delete', destructive: true }))) return;
      try {
        await api(`/api/workout/routines/${r.id}`, { method: 'DELETE' });
        routines = routines.filter((x) => x.id !== r.id);
        draw();
      } catch (err) {
        toast(errText(err, 'delete'), { kind: 'error' });
      }
    }
  }

  draw();
  const tick = setInterval(() => { if (active) draw(); }, 30000);
  cleanupView = () => clearInterval(tick);
  const [synced, data, history, programData] = await Promise.all([syncActive(), api('/api/workout/routines').catch((err) => ({ err })), api('/api/workout/sessions?limit=50').catch(() => null), api('/api/workout/program').catch((err) => ({ err }))]);
  if (!alive()) return;
  active = synced;
  sessions = history?.sessions || [];
  program = programData.program || null;
  if (programData.err && programData.err.status !== 404) toast(errText(programData.err, 'load program'), { kind: 'error' });
  if (data.err) {
    routines = [];
    toast(errText(data.err), { kind: 'error' });
  } else {
    routines = data.routines || [];
  }
  draw();
}

// ---- History tab

function weekStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
  return x;
}

function weeklyChart(stats) {
  const weeks = [];
  const thisWeek = weekStart(new Date());
  for (let i = 11; i >= 0; i -= 1) {
    const start = new Date(thisWeek);
    start.setDate(start.getDate() - i * 7);
    weeks.push({ start, count: 0, seconds: 0, volume: 0 });
  }
  for (const s of stats) {
    const ws = weekStart(new Date(s.started_at)).getTime();
    const w = weeks.find((x) => x.start.getTime() === ws);
    if (w) { w.count += 1; w.seconds += s.seconds; w.volume += s.volume_kg; }
  }
  const cur = weeks[weeks.length - 1];
  return barChart({
    title: 'Workouts per week',
    summary: `This week: ${cur.count} workout${cur.count === 1 ? '' : 's'} · ${fmtLong(cur.seconds)}`,
    points: weeks.map((w) => {
      const end = new Date(w.start);
      end.setDate(end.getDate() + 6);
      return {
        label: w.start.getDate() <= 7 || w === weeks[0] ? fmt.date(w.start, { day: false }) : '',
        value: w.count,
        text: `${fmt.date(w.start)} – ${fmt.date(end)}: ${w.count} workout${w.count === 1 ? '' : 's'}${w.count ? ` · ${fmtLong(w.seconds)} · ${fmtVolume(w.volume)}` : ''}`,
      };
    }),
  });
}

function sessionCard(s) {
  const prs = s.prs.length;
  const lines = s.exercises.slice(0, 4).map((e) => el('div', { class: 'wo-card-line' },
    el('span', { class: 'wo-card-sets', text: `${e.sets.length} ×` }), el('span', { text: e.name })));
  if (s.exercises.length > 4) lines.push(el('div', { class: 'wo-card-line muted', text: `+ ${s.exercises.length - 4} more` }));
  return el('button', { type: 'button', class: 'card wo-session', 'on:click': () => ctx.nav.go(`#/workout/s/${s.id}`) },
    el('div', { class: 'wo-session-title', text: s.title }),
    el('div', { class: 'wo-session-date muted', text: fmt.date(s.started_at, { weekday: 'long', time: true }) }),
    el('div', { class: 'wo-mini-stats' },
      miniStat('Time', fmtLong(s.seconds)),
      miniStat('Volume', fmtVolume(s.volume_kg)),
      prs ? miniStat('Records', String(prs)) : miniStat('Sets', String(s.set_count))),
    el('div', { class: 'wo-card-lines' }, ...lines));
}

const miniStat = (k, v) => el('div', null, el('span', { class: 'wo-stat-k', text: k }), el('span', { class: 'wo-stat-v', text: v }));

async function historyTab(body, alive) {
  const since = new Date(weekStart(new Date()).getTime() - 12 * 7 * 86400e3).toISOString();
  try {
    const [stats, page] = await Promise.all([
      api(`/api/workout/stats?since=${encodeURIComponent(since)}`),
      api('/api/workout/sessions?limit=20'),
    ]);
    if (!alive()) return;
    const listEl = el('div', { class: 'wo-session-list' }, ...page.sessions.map(sessionCard));
    const more = el('button', { type: 'button', class: 'button', text: 'Load More', hidden: !page.more });
    let last = page.sessions[page.sessions.length - 1];
    more.addEventListener('click', async () => {
      more.disabled = true;
      try {
        const next = await api(`/api/workout/sessions?limit=20&before=${encodeURIComponent(last.started_at)}`);
        if (!alive()) return;
        listEl.append(...next.sessions.map(sessionCard));
        last = next.sessions[next.sessions.length - 1] || last;
        more.hidden = !next.more;
      } catch (err) {
        toast(errText(err), { kind: 'error' });
      } finally {
        more.disabled = false;
      }
    });
    body.replaceChildren(
      weeklyChart(stats.sessions || []),
      section('Workouts'),
      page.sessions.length ? listEl : emptyState('No workouts yet. Start one from the Workout tab.'),
      more);
  } catch (err) {
    if (alive()) body.replaceChildren(emptyState(errText(err)));
  }
}

// ---- Exercises tab

async function exercisesTab(body, alive) {
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Search exercises', value: exQuery.q, 'aria-label': 'Search exercises', autocomplete: 'off', autocorrect: 'off' });
  const chips = el('div', { class: 'chips' });
  const list = el('ul', { class: 'card list wo-ex-list' });
  const drawChips = () => chips.replaceChildren(...['', ...MUSCLES].map((m) => el('button', {
    type: 'button', class: 'chip', text: m || 'All', 'aria-pressed': String(exQuery.muscle === m),
    'on:click': () => { exQuery.muscle = m; drawChips(); draw(); },
  })));
  const draw = () => {
    const words = exQuery.q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = cachedLibrary().filter((e) => (!exQuery.muscle || e.muscle === exQuery.muscle) &&
      words.every((w) => `${e.name} ${e.muscle} ${e.equipment}`.toLowerCase().includes(w)));
    list.replaceChildren(...hits.map((e) => el('li', null, el('button', { type: 'button', class: 'wo-ex-row', 'on:click': () => ctx.nav.go(`#/workout/e/${e.id}`) },
      el('span', { class: 'wo-pick-text' },
        el('span', { class: 'wo-pick-name', text: e.name }),
        el('span', { class: 'wo-pick-meta', text: `${e.muscle} · ${e.equipment}${e.custom ? ' · Custom' : ''}` })),
      e.times ? el('span', { class: 'wo-ex-count muted', text: `${e.times}×` }) : null,
      icon('chevron-right', { size: 18 })))));
    if (!hits.length) list.replaceChildren(el('li', { class: 'wo-pick-empty', text: 'No exercises match.' }));
  };
  search.addEventListener('input', () => { exQuery.q = search.value; draw(); });
  drawChips();
  try {
    await loadLibrary(true);
  } catch (err) {
    if (alive()) body.replaceChildren(emptyState(errText(err)));
    return;
  }
  if (!alive()) return;
  body.replaceChildren(search, chips, list);
  draw();
}

// ---------------------------------------------------------------- logger views

async function activeView(alive) {
  let draft = readActive();
  if (!draft) {
    root.append(navbar({ title: 'Workout', back: true }), el('div', { class: 'app-content' }, loading()));
    draft = await syncActive();
    if (!alive()) return;
    if (!draft) return nav.replace('#/workout');
    root.replaceChildren();
  }
  draft.mode = 'active';
  await loadLibrary().catch(() => {});
  if (!alive()) return;
  cleanupView = mountLogger(root, ctx, draft);
}

async function editView(id, alive) {
  root.append(navbar({ title: 'Edit Workout', back: true }), el('div', { class: 'app-content' }, loading()));
  try {
    const { session } = await api(`/api/workout/sessions/${id}`);
    if (!alive()) return;
    root.replaceChildren();
    cleanupView = mountLogger(root, ctx, draftFromSession(session, 'edit'));
  } catch (err) {
    if (alive()) root.lastChild.replaceChildren(emptyState(errText(err)));
  }
}

async function routineView(id, alive) {
  if (id === null) {
    const fromSession = store.get('workout.routineSeed', null);
    store.del('workout.routineSeed');
    const draft = draftFromRoutine(null);
    if (fromSession) {
      draft.title = fromSession.name;
      draft.exercises = fromSession.exercises;
      draft.notes = fromSession.notes || '';
    }
    cleanupView = mountLogger(root, ctx, draft);
    return;
  }
  root.append(navbar({ title: 'Routine', back: true }), el('div', { class: 'app-content' }, loading()));
  try {
    const { routines } = await api('/api/workout/routines');
    if (!alive()) return;
    const routine = routines.find((r) => r.id === id);
    if (!routine) return root.lastChild.replaceChildren(emptyState('That routine is gone.'));
    root.replaceChildren();
    cleanupView = mountLogger(root, ctx, draftFromRoutine(routine));
  } catch (err) {
    if (alive()) root.lastChild.replaceChildren(emptyState(errText(err)));
  }
}

// ---------------------------------------------------------------- one workout

async function sessionView(id, isNew, alive) {
  const more = navButton({ icon: 'more', label: 'Workout options' });
  const content = el('div', { class: 'app-content' }, loading());
  root.append(navbar({ title: 'Workout', back: true, right: [more] }), content);
  let session;
  try {
    ({ session } = await api(`/api/workout/sessions/${id}`));
  } catch (err) {
    if (alive()) content.replaceChildren(emptyState(err && err.status === 404 ? 'That workout is gone.' : errText(err)));
    return;
  }
  if (!alive()) return;

  more.addEventListener('click', async () => {
    const choice = await actionSheet({
      title: session.title,
      actions: [
        { label: 'Edit Workout', value: 'edit' },
        { label: 'Repeat Workout', value: 'repeat' },
        { label: 'Save as Routine', value: 'routine' },
        { label: 'Delete Workout', value: 'delete', destructive: true },
      ],
    });
    if (choice === 'edit') ctx.nav.go(`#/workout/s/${id}/edit`);
    if (choice === 'repeat') {
      const draft = draftFromSession(session, 'active');
      draft.title = session.title;
      startWorkout(draft);
    }
    if (choice === 'routine') {
      const seed = draftFromSession(session, 'routine');
      for (const ex of seed.exercises) for (const s of ex.sets) s.done = false;
      store.set('workout.routineSeed', { name: session.title, notes: seed.notes, exercises: seed.exercises });
      ctx.nav.go('#/workout/r/new');
    }
    if (choice === 'delete') {
      if (!(await confirmSheet({ title: 'Delete this workout?', message: 'Its sets and records go too.', confirmLabel: 'Delete', destructive: true }))) return;
      try {
        await api(`/api/workout/sessions/${id}`, { method: 'DELETE' });
        haptic('success');
        nav.replace('#/workout/history');
      } catch (err) {
        toast(errText(err, 'delete'), { kind: 'error' });
      }
    }
  });

  const out = [];
  if (isNew) {
    out.push(el('div', { class: 'card wo-done-card' },
      el('div', { class: 'wo-done-title', text: 'Workout complete' }),
      el('div', { class: 'muted', text: session.prs.length ? `${session.prs.length} new record${session.prs.length === 1 ? '' : 's'}. Nice work.` : 'Saved. Nice work.' })));
  }
  out.push(
    el('h2', { class: 'wo-detail-title', text: session.title }),
    el('div', { class: 'muted wo-detail-date', text: fmt.date(session.started_at, { weekday: 'long', year: true, time: true }) }),
    el('div', { class: 'wo-mini-stats wo-detail-stats' },
      miniStat('Time', fmtLong(session.seconds)),
      miniStat('Volume', fmtVolume(session.volume_kg)),
      miniStat('Sets', String(session.set_count)),
      miniStat('Records', String(session.prs.length))),
  );
  if (session.notes) out.push(el('p', { class: 'wo-notes', text: session.notes }));
  if (session.prs.length) {
    const nameOf = (eid) => (session.exercises.find((e) => e.exercise_id === eid) || {}).name || 'Exercise';
    out.push(section('Records'), el('ul', { class: 'card list' }, ...session.prs.map((p) => el('li', { class: 'kv' },
      el('span', { class: 'wo-pr-badge', 'aria-hidden': 'true' }, icon('check', { size: 12, strokeWidth: 3 })),
      el('span', { class: 'k wo-pr-name', text: `${nameOf(p.exercise_id)} · ${PR_LABELS[p.type]}` }),
      el('span', { class: 'v', text: prValue(p.type, p.value) })))));
  }
  out.push(section('Exercises'));
  for (const ex of session.exercises) {
    const labels = setLabels(ex.sets);
    out.push(el('div', { class: 'card wo-detail-ex' },
      el('button', { type: 'button', class: 'wo-detail-ex-name', 'on:click': () => ctx.nav.go(`#/workout/e/${ex.exercise_id}`) },
        el('span', { text: ex.name }), icon('chevron-right', { size: 18 })),
      ex.note ? el('div', { class: 'muted wo-detail-note', text: ex.note }) : null,
      ...ex.sets.map((s, i) => el('div', { class: 'wo-detail-set' },
        el('span', { class: `wo-set-label k-${s.kind}`, text: labels[i] }),
        el('span', { text: setText(ex.kind, s, ex.distance_unit) }),
        ex.kind === 'weight' && s.weight_kg && s.reps ? el('span', { class: 'muted wo-e1rm', text: `1RM ${fmtWeight(e1rm(s.weight_kg, s.reps))}` }) : null))));
  }
  content.replaceChildren(...out);
}

// ---------------------------------------------------------------- one exercise

async function exerciseView(id, alive) {
  const more = navButton({ icon: 'more', label: 'Exercise options' });
  more.hidden = true;
  const bar = navbar({ title: 'Exercise', back: true, right: [more] });
  const content = el('div', { class: 'app-content' }, loading());
  root.append(bar, content);
  let data;
  try {
    data = await api(`/api/workout/exercises/${id}/history`);
  } catch (err) {
    if (alive()) content.replaceChildren(emptyState(err && err.status === 404 ? 'That exercise is gone.' : errText(err)));
    return;
  }
  if (!alive()) return;
  const { exercise: ex, sessions, records } = data;
  bar.setTitle(ex.name);

  if (ex.custom) {
    more.hidden = false;
    more.addEventListener('click', async () => {
      const choice = await actionSheet({ title: ex.name, actions: [{ label: 'Edit Exercise', value: 'edit' }, { label: 'Delete Exercise', value: 'delete', destructive: true }] });
      if (choice === 'edit') {
        const fields = [
          { key: 'name', label: 'Name', value: ex.name, required: true },
          { key: 'muscle', label: 'Muscle group', type: 'select', value: ex.muscle, options: MUSCLES.map((m) => ({ value: m, label: m })) },
          { key: 'equipment', label: 'Equipment', type: 'select', value: ex.equipment, options: EQUIPMENT.map((m) => ({ value: m, label: m })) },
        ];
        if (!sessions.length) fields.push({ key: 'kind', label: 'Tracks', type: 'select', value: ex.kind, options: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })) });
        const result = await formSheet({ title: 'Edit exercise', fields });
        if (!result || result === 'delete') return;
        try {
          await api(`/api/workout/exercises/${id}`, { method: 'PATCH', body: result });
          await loadLibrary(true);
          show(currentSub);
        } catch (err) {
          toast(errText(err, 'save'), { kind: 'error' });
        }
      }
      if (choice === 'delete') {
        if (!(await confirmSheet({ title: `Delete ${ex.name}?`, confirmLabel: 'Delete', destructive: true }))) return;
        try {
          await api(`/api/workout/exercises/${id}`, { method: 'DELETE' });
          await loadLibrary(true);
          ctx.nav.back();
        } catch (err) {
          toast(errText(err, 'delete'), { kind: 'error' });
        }
      }
    });
  }

  const out = [el('div', { class: 'muted wo-ex-meta', text: `${ex.muscle} · ${ex.equipment} · ${KIND_LABELS[ex.kind]}` })];
  if (!sessions.length) {
    out.push(emptyState('No sets logged yet. Add it to a workout and its progress shows here.'));
    content.replaceChildren(...out);
    return;
  }

  // Chart: one point per workout, oldest first.
  const ordered = sessions.slice().reverse().slice(-40);
  const metrics = ex.kind === 'weight'
    ? [['e1rm', 'Best est. 1RM'], ['weight', 'Heaviest weight'], ['volume', 'Session volume']]
    : ex.kind === 'reps' ? [['reps', 'Most reps']]
      : ex.kind === 'time' ? [['time', 'Longest time']] : [['distance', 'Longest distance'], ['time', 'Longest time']];
  let metric = store.get('workout.metric', 'e1rm');
  if (!metrics.some(([m]) => m === metric)) metric = metrics[0][0];
  const valueOf = (s, m) => {
    const work = s.sets.filter((x) => x.kind !== 'warmup');
    const sets = work.length ? work : s.sets;
    if (m === 'e1rm') return Math.max(0, ...sets.map((x) => e1rm(x.weight_kg, x.reps)));
    if (m === 'weight') return Math.max(0, ...sets.map((x) => x.weight_kg || 0));
    if (m === 'volume') return s.sets.reduce((n, x) => n + (x.weight_kg || 0) * (x.reps || 0), 0);
    if (m === 'reps') return Math.max(0, ...sets.map((x) => x.reps || 0));
    if (m === 'time') return Math.max(0, ...sets.map((x) => x.seconds || 0));
    return Math.max(0, ...sets.map((x) => x.meters || 0));
  };
  const show_ = (m, v) => (m === 'volume' ? fmtVolume(v) : prValue(m, v));
  const chartHost = el('div');
  const drawChart = () => {
    const label = metrics.find(([m]) => m === metric)[1];
    const points = ordered.map((s) => ({ value: valueOf(s, metric), text: `${fmt.date(s.started_at)}: ${show_(metric, valueOf(s, metric))}` }));
    const best = Math.max(...points.map((p) => p.value));
    chartHost.replaceChildren(lineChart({
      title: label,
      summary: `Best: ${show_(metric, best)}`,
      points,
      format: (v) => (metric === 'time' ? fmtClock(v) : metric === 'distance' ? `${fmtDist(v)} ${distUnit()}` : metric === 'reps' ? String(Math.round(v)) : `${fmtWeight(metric === 'volume' ? Math.round(v) : v)} ${getUnits()}`),
    }));
  };
  if (metrics.length > 1) {
    const seg = el('div', { class: 'segmented wo-metric' }, ...metrics.map(([m, label]) => el('button', {
      type: 'button', text: label.replace('Best est. ', '').replace('Heaviest weight', 'Weight').replace('Session volume', 'Volume').replace('Longest ', ''),
      'aria-pressed': String(metric === m),
      'on:click': (e) => {
        metric = m;
        store.set('workout.metric', m);
        for (const b of seg.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
        drawChart();
      },
    })));
    out.push(seg);
  }
  drawChart();
  out.push(chartHost);

  const rec = [];
  const kv = (k, v) => el('li', { class: 'kv' }, el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }));
  for (const key of ['weight', 'e1rm', 'volume', 'reps', 'time', 'distance']) {
    if (records[key]) rec.push(kv(PR_LABELS[key], prValue(key, records[key])));
  }
  rec.push(kv('Workouts', String(sessions.length)), kv('Total sets', String(records.total_sets)));
  if (records.total_volume) rec.push(kv('Total volume', fmtVolume(records.total_volume)));
  out.push(section('Personal records'), el('ul', { class: 'card list' }, ...rec));

  out.push(section('History'));
  for (const s of sessions.slice(0, 50)) {
    const labels = setLabels(s.sets);
    out.push(el('button', { type: 'button', class: 'card wo-detail-ex wo-hist', 'on:click': () => ctx.nav.go(`#/workout/s/${s.id}`) },
      el('div', { class: 'wo-hist-head' }, el('span', { class: 'wo-hist-title', text: s.title }), el('span', { class: 'muted', text: fmt.date(s.started_at) })),
      ...s.sets.map((x, i) => el('div', { class: 'wo-detail-set' },
        el('span', { class: `wo-set-label k-${x.kind}`, text: labels[i] }),
        el('span', { text: setText(ex.kind, x, ex.distance_unit) })))));
  }
  content.replaceChildren(...out);
}
