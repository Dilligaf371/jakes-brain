// Workout: a Hevy-style strength log. An exercise library (built-in + custom), routines
// (saved templates), logged workouts made of exercises and sets, personal records, and the
// in-progress workout (so it survives a reload and follows Jake from the phone to the PC).
//
// Exercise kinds decide which numbers a set has:
//   weight -> weight_kg + reps   reps -> reps   time -> seconds   cardio -> meters + seconds
// Set kinds: normal | warmup | drop | failure. Weights are stored in kg, distances in metres;
// the client converts to lb / miles for display.
//
// Routes:
//   GET    /api/workout/exercises                  -> { exercises: [{id, name, muscle, equipment, kind, custom, times, last_used}] }
//   POST   /api/workout/exercises {name, muscle, equipment, kind} -> 201 { exercise }
//   PATCH  /api/workout/exercises/:id {name?, muscle?, equipment?, kind?} -> { exercise }   (custom only; kind only while unused)
//   DELETE /api/workout/exercises/:id              -> 204   (custom and unused only, else 409)
//   GET    /api/workout/exercises/:id/history      -> { exercise, sessions: [{id, title, started_at, sets}], records }
//   GET    /api/workout/previous?ids=1,2&exclude=<session id> -> { previous: { <exercise id>: [sets of the last workout with it] } }
//   GET    /api/workout/sessions?before=<started_at ISO>&limit=20 -> { sessions: [session], more }
//   POST   /api/workout/sessions {title, started_at, ended_at, notes?, routine_id?, advance_program?, exercises} -> 201 { session }
//   GET    /api/workout/sessions/:id               -> { session }
//   PUT    /api/workout/sessions/:id {same as POST} -> { session }   (replaces the whole workout)
//   DELETE /api/workout/sessions/:id               -> 204
//   GET    /api/workout/stats?since=<ISO>          -> { sessions: [{id, started_at, seconds, volume_kg, sets}] }
//   GET    /api/workout/routines                   -> { routines: [routine] }
//   POST   /api/workout/routines {name, exercises, notes?, weekdays?, source_id?, source_url?} -> 201 { routine }
//   PUT    /api/workout/routines/:id {same as POST} -> { routine } (omitted metadata is preserved)
//   DELETE /api/workout/routines/:id               -> 204
//   GET    /api/workout/program                    -> { program: program | null }
//   PUT    /api/workout/program {name, routine_ids, cursor?, notes?, source_id?, source_url?, weekdays?, assessments?, source_progress?, prior_completed?} -> { program }
//   PATCH  /api/workout/program {cursor?, expected_cursor?, expected_updated_at?, weekdays?, assessments?} -> { program }
//   GET    /api/workout/active                     -> { active: <client draft object> | null, updated_at }
//   PUT    /api/workout/active {active}            -> { updated_at }
//   DELETE /api/workout/active                     -> 204
//   GET    /api/workout/badge                      -> { count: 1 while a workout is in progress, else 0 }
//
// A session is { id, title, notes, routine_id, started_at, ended_at, seconds, volume_kg,
// set_count, prs: [{exercise_id, type, value}], exercises: [{exercise_id, name, kind, muscle,
// equipment, note, rest, sets: [{kind, weight_kg, reps, seconds, meters}]}] }. Only completed
// sets are stored. A PR is a best (heaviest weight, best estimated 1RM, best set volume, most
// reps, longest time, longest distance) beating every earlier workout with that exercise,
// warm-ups excluded; a first-ever workout with an exercise sets no PR.
// A routine is {id, name, notes, weekdays, source_id, source_url, exercises, created_at,
// updated_at}. weekdays is an array of 0 (Sunday) through 6 (Saturday); [] is unscheduled.
// Exercises stay in array order and may include prescription (exact targets/ranges, max
// 2000 chars) separately from note and numeric sets. Optional distance_unit is m|yd|km|mi
// ('' uses the user's display preference); canonical distances always remain in meters.
// When logging a session, prescription
// is saved in the exercise note so the original plan remains alongside actual results.
// A program contains ordered, distinct routine_ids; cursor is the next index (the array
// length means complete). assessments: [{title, before_index?, items:[{text,done,result?}]}].
// Assessment result (max 1000 chars) stores measured times/observations separately from
// the original task text; it defaults to ''.
// source_progress: [{routine_id, items:[{text,done}]}] is the immutable imported checklist,
// separate from actual logged sets. completed: [{routine_id,session_id}] is server-owned.
// prior_completed: [routine_id] records completion confirmed before import, without
// inventing sessions, dates or sets. It defaults to [].
// Saving a NEW session for the current routine advances once, atomically with the save.
// Missing planned sets keep the cursor in place, unless advance_program:true explicitly
// confirms moving on; false always keeps the cursor. A replay selected as current advances
// and updates its single completion link. Editing/repeating never advances another routine.
// PATCH only changes
// the requested cursor/weekdays/assessments; expected_cursor or expected_updated_at can
// prevent stale updates (409). updated_at changes on every save, even within one millisecond.
// weekdays are training-day hints; missed days never skip the next routine.
import { readJsonBody, sendJson, sendEmpty, HttpError } from '../http.js';

export const KINDS = ['weight', 'reps', 'time', 'cardio'];
export const SET_KINDS = ['normal', 'warmup', 'drop', 'failure'];
export const MUSCLES = ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Legs', 'Glutes', 'Core', 'Cardio', 'Full Body', 'Other'];
export const EQUIPMENT = ['Barbell', 'Dumbbell', 'Machine', 'Cable', 'Bodyweight', 'Kettlebell', 'Band', 'Other'];

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_EXERCISES = 60;
const MAX_SETS = 60;

// [name, muscle, equipment, kind]
const LIBRARY = [
  ['Bench Press (Barbell)', 'Chest', 'Barbell', 'weight'],
  ['Incline Bench Press (Barbell)', 'Chest', 'Barbell', 'weight'],
  ['Bench Press (Dumbbell)', 'Chest', 'Dumbbell', 'weight'],
  ['Incline Bench Press (Dumbbell)', 'Chest', 'Dumbbell', 'weight'],
  ['Chest Fly (Dumbbell)', 'Chest', 'Dumbbell', 'weight'],
  ['Cable Fly Crossover', 'Chest', 'Cable', 'weight'],
  ['Chest Press (Machine)', 'Chest', 'Machine', 'weight'],
  ['Pec Deck (Machine)', 'Chest', 'Machine', 'weight'],
  ['Push Up', 'Chest', 'Bodyweight', 'reps'],
  ['Chest Dip', 'Chest', 'Bodyweight', 'reps'],
  ['Deadlift (Barbell)', 'Back', 'Barbell', 'weight'],
  ['Bent Over Row (Barbell)', 'Back', 'Barbell', 'weight'],
  ['Dumbbell Row', 'Back', 'Dumbbell', 'weight'],
  ['T-Bar Row', 'Back', 'Machine', 'weight'],
  ['Lat Pulldown (Cable)', 'Back', 'Cable', 'weight'],
  ['Seated Cable Row', 'Back', 'Cable', 'weight'],
  ['Pull Up', 'Back', 'Bodyweight', 'reps'],
  ['Chin Up', 'Back', 'Bodyweight', 'reps'],
  ['Weighted Pull Up', 'Back', 'Bodyweight', 'weight'],
  ['Back Extension', 'Back', 'Bodyweight', 'reps'],
  ['Face Pull (Cable)', 'Shoulders', 'Cable', 'weight'],
  ['Overhead Press (Barbell)', 'Shoulders', 'Barbell', 'weight'],
  ['Shoulder Press (Dumbbell)', 'Shoulders', 'Dumbbell', 'weight'],
  ['Shoulder Press (Machine)', 'Shoulders', 'Machine', 'weight'],
  ['Arnold Press (Dumbbell)', 'Shoulders', 'Dumbbell', 'weight'],
  ['Lateral Raise (Dumbbell)', 'Shoulders', 'Dumbbell', 'weight'],
  ['Lateral Raise (Cable)', 'Shoulders', 'Cable', 'weight'],
  ['Front Raise (Dumbbell)', 'Shoulders', 'Dumbbell', 'weight'],
  ['Rear Delt Fly (Dumbbell)', 'Shoulders', 'Dumbbell', 'weight'],
  ['Shrug (Dumbbell)', 'Back', 'Dumbbell', 'weight'],
  ['Bicep Curl (Barbell)', 'Biceps', 'Barbell', 'weight'],
  ['Bicep Curl (Dumbbell)', 'Biceps', 'Dumbbell', 'weight'],
  ['Hammer Curl (Dumbbell)', 'Biceps', 'Dumbbell', 'weight'],
  ['Preacher Curl', 'Biceps', 'Barbell', 'weight'],
  ['Bicep Curl (Cable)', 'Biceps', 'Cable', 'weight'],
  ['Triceps Pushdown (Cable)', 'Triceps', 'Cable', 'weight'],
  ['Skullcrusher (Barbell)', 'Triceps', 'Barbell', 'weight'],
  ['Overhead Triceps Extension (Dumbbell)', 'Triceps', 'Dumbbell', 'weight'],
  ['Close Grip Bench Press', 'Triceps', 'Barbell', 'weight'],
  ['Triceps Dip', 'Triceps', 'Bodyweight', 'reps'],
  ['Squat (Barbell)', 'Legs', 'Barbell', 'weight'],
  ['Front Squat (Barbell)', 'Legs', 'Barbell', 'weight'],
  ['Goblet Squat', 'Legs', 'Dumbbell', 'weight'],
  ['Hack Squat (Machine)', 'Legs', 'Machine', 'weight'],
  ['Leg Press (Machine)', 'Legs', 'Machine', 'weight'],
  ['Leg Extension (Machine)', 'Legs', 'Machine', 'weight'],
  ['Lying Leg Curl (Machine)', 'Legs', 'Machine', 'weight'],
  ['Seated Leg Curl (Machine)', 'Legs', 'Machine', 'weight'],
  ['Romanian Deadlift (Barbell)', 'Legs', 'Barbell', 'weight'],
  ['Romanian Deadlift (Dumbbell)', 'Legs', 'Dumbbell', 'weight'],
  ['Bulgarian Split Squat', 'Legs', 'Dumbbell', 'weight'],
  ['Lunge (Dumbbell)', 'Legs', 'Dumbbell', 'weight'],
  ['Calf Raise (Machine)', 'Legs', 'Machine', 'weight'],
  ['Seated Calf Raise', 'Legs', 'Machine', 'weight'],
  ['Hip Thrust (Barbell)', 'Glutes', 'Barbell', 'weight'],
  ['Hip Abduction (Machine)', 'Glutes', 'Machine', 'weight'],
  ['Glute Bridge', 'Glutes', 'Bodyweight', 'reps'],
  ['Plank', 'Core', 'Bodyweight', 'time'],
  ['Side Plank', 'Core', 'Bodyweight', 'time'],
  ['Crunch', 'Core', 'Bodyweight', 'reps'],
  ['Hanging Leg Raise', 'Core', 'Bodyweight', 'reps'],
  ['Cable Crunch', 'Core', 'Cable', 'weight'],
  ['Russian Twist', 'Core', 'Bodyweight', 'reps'],
  ['Ab Wheel', 'Core', 'Other', 'reps'],
  ['Kettlebell Swing', 'Full Body', 'Kettlebell', 'weight'],
  ['Farmer\'s Walk', 'Full Body', 'Dumbbell', 'weight'],
  ['Burpee', 'Full Body', 'Bodyweight', 'reps'],
  ['Running', 'Cardio', 'Other', 'cardio'],
  ['Treadmill', 'Cardio', 'Machine', 'cardio'],
  ['Walking', 'Cardio', 'Other', 'cardio'],
  ['Cycling', 'Cardio', 'Machine', 'cardio'],
  ['Rowing Machine', 'Cardio', 'Machine', 'cardio'],
  ['Stair Climber', 'Cardio', 'Machine', 'time'],
  ['Elliptical', 'Cardio', 'Machine', 'time'],
  ['Jump Rope', 'Cardio', 'Other', 'time'],
];

const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;
const SEED_SQL = LIBRARY.map(([name, muscle, equipment, kind]) =>
  `INSERT OR IGNORE INTO workout_exercises (name, muscle, equipment, kind, custom, created_at) VALUES (${sqlString(name)}, ${sqlString(muscle)}, ${sqlString(equipment)}, ${sqlString(kind)}, 0, '2026-11-02T00:00:00.000Z');`).join('\n');

export default {
  id: 'workout',
  migrations: [
    {
      id: 'workout-1',
      sql: `
        CREATE TABLE IF NOT EXISTS workout_exercises (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
          muscle     TEXT    NOT NULL DEFAULT 'Other',
          equipment  TEXT    NOT NULL DEFAULT 'Other',
          kind       TEXT    NOT NULL DEFAULT 'weight',
          custom     INTEGER NOT NULL DEFAULT 1,
          created_at TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workout_sessions (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          title      TEXT    NOT NULL,
          notes      TEXT    NOT NULL DEFAULT '',
          routine_id INTEGER,
          started_at TEXT    NOT NULL,
          ended_at   TEXT    NOT NULL,
          created_at TEXT    NOT NULL,
          updated_at TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS workout_sessions_started ON workout_sessions (started_at DESC);
        CREATE TABLE IF NOT EXISTS workout_entries (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id  INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
          exercise_id INTEGER NOT NULL,
          position    INTEGER NOT NULL,
          note        TEXT    NOT NULL DEFAULT '',
          rest        INTEGER
        );
        CREATE INDEX IF NOT EXISTS workout_entries_session ON workout_entries (session_id, position);
        CREATE TABLE IF NOT EXISTS workout_sets (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          entry_id    INTEGER NOT NULL REFERENCES workout_entries(id) ON DELETE CASCADE,
          session_id  INTEGER NOT NULL,
          exercise_id INTEGER NOT NULL,
          position    INTEGER NOT NULL,
          kind        TEXT    NOT NULL DEFAULT 'normal',
          weight_kg   REAL,
          reps        INTEGER,
          seconds     INTEGER,
          meters      REAL
        );
        CREATE INDEX IF NOT EXISTS workout_sets_entry ON workout_sets (entry_id, position);
        CREATE INDEX IF NOT EXISTS workout_sets_exercise ON workout_sets (exercise_id, session_id);
        CREATE TABLE IF NOT EXISTS workout_routines (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT    NOT NULL,
          data       TEXT    NOT NULL,
          created_at TEXT    NOT NULL,
          updated_at TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workout_active (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          data       TEXT    NOT NULL,
          updated_at TEXT    NOT NULL
        );
        ${SEED_SQL}
      `,
    },
    {
      id: 'workout-2',
      sql: `CREATE TABLE IF NOT EXISTS workout_program (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
    },
    {
      id: 'workout-3',
      sql: "ALTER TABLE workout_entries ADD COLUMN distance_unit TEXT NOT NULL DEFAULT '';",
    },
  ],
  register(r, ctx) {
    const repo = workoutRepo(ctx.db);

    // ---- exercises
    r.get('/api/workout/exercises', () => ({ exercises: repo.exercises(), muscles: MUSCLES, equipment: EQUIPMENT, kinds: KINDS }));

    r.post('/api/workout/exercises', async (req, res) => {
      const body = await readJsonBody(req);
      const name = text(body.name, 'name', { max: 80, required: true });
      if (repo.exerciseByName(name)) throw new HttpError(409, `${name} is already in the library`);
      const ex = repo.createExercise({
        name,
        muscle: oneOf(body.muscle ?? 'Other', MUSCLES, 'muscle'),
        equipment: oneOf(body.equipment ?? 'Other', EQUIPMENT, 'equipment'),
        kind: oneOf(body.kind ?? 'weight', KINDS, 'kind'),
      });
      sendJson(res, 201, { exercise: ex });
    });

    r.patch('/api/workout/exercises/:id', async (req, res, { params }) => {
      const ex = repo.exercise(parseId(params.id));
      if (!ex) throw new HttpError(404, 'exercise not found');
      if (!ex.custom) throw new HttpError(409, 'built-in exercises cannot be changed');
      const body = await readJsonBody(req);
      const next = { ...ex };
      if (body.name !== undefined) {
        next.name = text(body.name, 'name', { max: 80, required: true });
        const clash = repo.exerciseByName(next.name);
        if (clash && clash.id !== ex.id) throw new HttpError(409, `${next.name} is already in the library`);
      }
      if (body.muscle !== undefined) next.muscle = oneOf(body.muscle, MUSCLES, 'muscle');
      if (body.equipment !== undefined) next.equipment = oneOf(body.equipment, EQUIPMENT, 'equipment');
      if (body.kind !== undefined) {
        next.kind = oneOf(body.kind, KINDS, 'kind');
        if (next.kind !== ex.kind && repo.timesUsed(ex.id) > 0) throw new HttpError(409, 'the type of an exercise you have logged cannot change');
      }
      return { exercise: repo.updateExercise(next) };
    });

    r.delete('/api/workout/exercises/:id', (req, res, { params }) => {
      const ex = repo.exercise(parseId(params.id));
      if (!ex) throw new HttpError(404, 'exercise not found');
      if (!ex.custom) throw new HttpError(409, 'built-in exercises cannot be deleted');
      const used = repo.timesUsed(ex.id);
      if (used) throw new HttpError(409, `used in ${used} workout${used === 1 ? '' : 's'}`);
      if (repo.routinesUsing(ex.id)) throw new HttpError(409, 'used in a routine');
      repo.deleteExercise(ex.id);
      sendEmpty(res, 204);
    });

    r.get('/api/workout/exercises/:id/history', (req, res, { params }) => {
      const ex = repo.exercise(parseId(params.id));
      if (!ex) throw new HttpError(404, 'exercise not found');
      const sessions = repo.exerciseHistory(ex.id);
      return { exercise: ex, sessions, records: records(ex.kind, sessions.flatMap((s) => s.sets)) };
    });

    r.get('/api/workout/previous', (req, res, { query }) => {
      const ids = String(query.ids || '').split(',').filter(Boolean).slice(0, MAX_EXERCISES).map((v) => parseId(v, 400));
      const exclude = query.exclude ? parseId(query.exclude, 400) : 0;
      const previous = {};
      for (const id of new Set(ids)) previous[id] = repo.previousSets(id, exclude);
      return { previous };
    });

    // ---- sessions
    r.get('/api/workout/sessions', (req, res, { query }) => {
      const limit = Math.min(50, Math.max(1, Number.parseInt(query.limit, 10) || 20));
      const before = query.before ? iso(query.before, 'before') : null;
      const rows = repo.sessionRows({ before, limit: limit + 1 });
      return { sessions: rows.slice(0, limit).map((row) => repo.hydrate(row)), more: rows.length > limit };
    });

    r.post('/api/workout/sessions', async (req, res) => {
      const input = validateSession(await readJsonBody(req, { limit: 512 * 1024 }), repo);
      sendJson(res, 201, { session: repo.saveSession(null, input) });
    });

    r.get('/api/workout/sessions/:id', (req, res, { params }) => {
      const session = repo.session(parseId(params.id));
      if (!session) throw new HttpError(404, 'workout not found');
      return { session };
    });

    r.put('/api/workout/sessions/:id', async (req, res, { params }) => {
      const id = parseId(params.id);
      if (!repo.session(id)) throw new HttpError(404, 'workout not found');
      const input = validateSession(await readJsonBody(req, { limit: 512 * 1024 }), repo);
      return { session: repo.saveSession(id, input) };
    });

    r.delete('/api/workout/sessions/:id', (req, res, { params }) => {
      if (!repo.deleteSession(parseId(params.id))) throw new HttpError(404, 'workout not found');
      sendEmpty(res, 204);
    });

    r.get('/api/workout/stats', (req, res, { query }) => {
      const since = query.since ? iso(query.since, 'since') : new Date(Date.now() - 120 * 86400e3).toISOString();
      return { sessions: repo.stats(since) };
    });

    // ---- routines
    r.get('/api/workout/routines', () => ({ routines: repo.routines() }));

    r.post('/api/workout/routines', async (req, res) => {
      const input = validateRoutine(await readJsonBody(req, { limit: 256 * 1024 }), repo);
      sendJson(res, 201, { routine: repo.saveRoutine(null, input) });
    });

    r.put('/api/workout/routines/:id', async (req, res, { params }) => {
      const id = parseId(params.id);
      const existing = repo.routine(id);
      if (!existing) throw new HttpError(404, 'routine not found');
      const input = validateRoutine(await readJsonBody(req, { limit: 256 * 1024 }), repo, existing);
      return { routine: repo.saveRoutine(id, input) };
    });

    r.delete('/api/workout/routines/:id', (req, res, { params }) => {
      const id = parseId(params.id);
      if (repo.program()?.routine_ids.includes(id)) throw new HttpError(409, 'this routine belongs to your program');
      if (!repo.deleteRoutine(id)) throw new HttpError(404, 'routine not found');
      sendEmpty(res, 204);
    });

    // ---- one ordered training program, with source progress kept separate from logs
    r.get('/api/workout/program', () => ({ program: repo.program() }));
    r.put('/api/workout/program', async (req) => {
      const body = await readJsonBody(req, { limit: 2 * 1024 * 1024 });
      const input = validateProgram(body, repo, repo.program());
      return { program: repo.saveProgram(input) };
    });
    r.patch('/api/workout/program', async (req) => {
      const body = await readJsonBody(req, { limit: 512 * 1024 });
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be an object');
      if (Object.keys(body).some((key) => !['cursor', 'expected_cursor', 'expected_updated_at', 'weekdays', 'assessments'].includes(key))) {
        throw new HttpError(400, 'PATCH only accepts cursor, expected_cursor, expected_updated_at, weekdays and assessments');
      }
      const current = repo.program();
      if (!current) throw new HttpError(404, 'program not found');
      if (body.expected_cursor !== undefined && body.expected_cursor !== current.cursor) {
        throw new HttpError(409, 'your program position changed; refresh and try again');
      }
      if (body.expected_updated_at !== undefined) {
        if (typeof body.expected_updated_at !== 'string') throw new HttpError(400, 'expected_updated_at must be a string');
        if (body.expected_updated_at !== current.updated_at) throw new HttpError(409, 'your program changed; refresh and try again');
      }
      const input = validateProgram({ ...current, ...body }, repo, current);
      return { program: repo.saveProgram(input) };
    });

    // ---- the workout in progress (opaque client JSON)
    r.get('/api/workout/active', () => repo.active());

    r.put('/api/workout/active', async (req) => {
      const body = await readJsonBody(req, { limit: 512 * 1024 });
      if (!body || typeof body.active !== 'object' || body.active === null || Array.isArray(body.active)) {
        throw new HttpError(400, 'active must be an object');
      }
      return { updated_at: repo.setActive(body.active) };
    });

    r.get('/api/workout/badge', () => ({ count: repo.active().active ? 1 : 0 }));

    r.delete('/api/workout/active', (req, res) => {
      repo.clearActive();
      sendEmpty(res, 204);
    });
  },
};

// ---------------------------------------------------------------- validation

function parseId(raw, status = 404) {
  const id = /^\d{1,15}$/.test(String(raw)) ? Number(raw) : 0;
  if (!id) throw new HttpError(status, status === 404 ? 'not found' : 'bad id');
  return id;
}

function text(value, name, { max = 200, required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);
  const out = value.trim();
  if (required && !out) throw new HttpError(400, `${name} is required`);
  if (out.length > max) throw new HttpError(400, `${name} is too long (max ${max})`);
  if (CONTROL.test(out)) throw new HttpError(400, `${name} contains control characters`);
  return out;
}

function oneOf(value, list, name) {
  if (!list.includes(value)) throw new HttpError(400, `${name} must be one of: ${list.join(', ')}`);
  return value;
}

function iso(value, name) {
  if (typeof value !== 'string' || !ISO_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, `${name} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function num(value, name, { max, integer = false }) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new HttpError(400, `${name} must be a number from 0 to ${max}`);
  }
  return integer ? Math.round(value) : Math.round(value * 1000) / 1000;
}

function validateSet(raw, where) {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, `${where} must be an object`);
  return {
    kind: oneOf(raw.kind ?? 'normal', SET_KINDS, `${where}.kind`),
    weight_kg: num(raw.weight_kg, `${where}.weight_kg`, { max: 2000 }),
    reps: num(raw.reps, `${where}.reps`, { max: 10000, integer: true }),
    seconds: num(raw.seconds, `${where}.seconds`, { max: 86400, integer: true }),
    meters: num(raw.meters, `${where}.meters`, { max: 1_000_000 }),
  };
}

function validateExerciseList(list, repo, { allowEmptySets }) {
  if (!Array.isArray(list)) throw new HttpError(400, 'exercises must be an array');
  if (list.length > MAX_EXERCISES) throw new HttpError(400, `at most ${MAX_EXERCISES} exercises`);
  return list.map((raw, i) => {
    const where = `exercises[${i}]`;
    if (!raw || typeof raw !== 'object') throw new HttpError(400, `${where} must be an object`);
    const exerciseId = Number(raw.exercise_id);
    if (!Number.isSafeInteger(exerciseId) || !repo.exercise(exerciseId)) throw new HttpError(400, `${where}.exercise_id is not in the library`);
    if (!Array.isArray(raw.sets)) throw new HttpError(400, `${where}.sets must be an array`);
    if (raw.sets.length > MAX_SETS) throw new HttpError(400, `${where}: at most ${MAX_SETS} sets`);
    if (!allowEmptySets && !raw.sets.length) throw new HttpError(400, `${where} has no sets`);
    const rest = raw.rest === undefined || raw.rest === null ? null : num(raw.rest, `${where}.rest`, { max: 1800, integer: true });
    const prescription = text(raw.prescription, `${where}.prescription`, { max: 2000 });
    const note = text(raw.note, `${where}.note`, { max: allowEmptySets ? 1000 : 7000 });
    const sessionNote = prescription ? [`Prescription: ${prescription}`, note].filter(Boolean).join('\n\n') : note;
    return {
      exercise_id: exerciseId,
      note: allowEmptySets ? note : text(sessionNote, `${where}.note`, { max: 7000 }),
      ...(allowEmptySets ? { prescription } : {}),
      distance_unit: oneOf(raw.distance_unit ?? '', ['', 'm', 'yd', 'km', 'mi'], `${where}.distance_unit`),
      rest,
      sets: raw.sets.map((s, j) => validateSet(s, `${where}.sets[${j}]`)),
    };
  });
}

function validateSession(body, repo) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be an object');
  const startedAt = iso(body.started_at, 'started_at');
  const endedAt = iso(body.ended_at, 'ended_at');
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw new HttpError(400, 'ended_at is before started_at');
  const exercises = validateExerciseList(body.exercises, repo, { allowEmptySets: false });
  if (!exercises.length) throw new HttpError(400, 'a workout needs at least one exercise');
  const routineId = body.routine_id === undefined || body.routine_id === null ? null : Number(body.routine_id);
  if (body.advance_program !== undefined && typeof body.advance_program !== 'boolean') throw new HttpError(400, 'advance_program must be true or false');
  return {
    title: text(body.title, 'title', { max: 100 }) || 'Workout',
    notes: text(body.notes, 'notes', { max: 4000 }),
    routine_id: Number.isSafeInteger(routineId) && routineId > 0 ? routineId : null,
    advance_program: body.advance_program,
    started_at: startedAt,
    ended_at: endedAt,
    exercises,
  };
}

function validateRoutine(body, repo, existing = null) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be an object');
  const value = (key, fallback) => body[key] === undefined ? (existing?.[key] ?? fallback) : body[key];
  const weekdays = value('weekdays', []);
  if (!Array.isArray(weekdays) || weekdays.length > 7 || weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new HttpError(400, 'weekdays must be an array of day numbers from 0 (Sunday) to 6 (Saturday)');
  }
  const sourceUrl = text(value('source_url', ''), 'source_url', { max: 2000 });
  if (sourceUrl) {
    let parsed;
    try { parsed = new URL(sourceUrl); } catch { /* rejected below */ }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'source_url must be an http or https URL');
  }
  // Older clients only know about numeric sets. Keep the prescription for the same
  // occurrence of an exercise if they save it without the new field.
  const prior = new Map();
  for (const ex of existing?.exercises || []) {
    if (!prior.has(ex.exercise_id)) prior.set(ex.exercise_id, []);
    prior.get(ex.exercise_id).push({ prescription: ex.prescription || '', distance_unit: ex.distance_unit || '' });
  }
  const exercises = Array.isArray(body.exercises) ? body.exercises.map((ex) => {
    const previous = prior.get(Number(ex?.exercise_id))?.shift() || {};
    return ex && typeof ex === 'object' ? {
      ...ex,
      prescription: ex.prescription === undefined ? (previous.prescription || '') : ex.prescription,
      distance_unit: ex.distance_unit === undefined ? (previous.distance_unit || '') : ex.distance_unit,
    } : ex;
  }) : body.exercises;
  return {
    name: text(body.name, 'name', { max: 100, required: true }),
    notes: text(value('notes', ''), 'notes', { max: 4000 }),
    weekdays: [...new Set(weekdays)].sort((a, b) => a - b),
    source_id: text(value('source_id', ''), 'source_id', { max: 200 }),
    source_url: sourceUrl,
    exercises: validateExerciseList(exercises, repo, { allowEmptySets: true }),
  };
}

function validateProgram(body, repo, existing = null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be an object');
  const value = (key, fallback) => body[key] === undefined ? (existing?.[key] ?? fallback) : body[key];
  const routineIds = value('routine_ids', []);
  if (!Array.isArray(routineIds) || !routineIds.length || routineIds.length > 200 ||
      routineIds.some((id) => !Number.isSafeInteger(id) || !repo.routine(id)) || new Set(routineIds).size !== routineIds.length) {
    throw new HttpError(400, 'routine_ids must contain 1 to 200 distinct existing routine IDs in order');
  }
  const cursor = value('cursor', 0);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > routineIds.length) throw new HttpError(400, 'cursor must be an index from 0 through the program length');
  const priorCompleted = value('prior_completed', []);
  if (!Array.isArray(priorCompleted) || priorCompleted.some((id) => !Number.isSafeInteger(id) || !routineIds.includes(id)) || new Set(priorCompleted).size !== priorCompleted.length) {
    throw new HttpError(400, 'prior_completed must be distinct routine IDs belonging to this program');
  }
  const weekdays = value('weekdays', []);
  if (!Array.isArray(weekdays) || weekdays.length > 7 || weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new HttpError(400, 'weekdays must be an array of day numbers from 0 (Sunday) to 6 (Saturday)');
  }
  const sourceUrl = text(value('source_url', ''), 'source_url', { max: 2000 });
  if (sourceUrl) {
    let parsed;
    try { parsed = new URL(sourceUrl); } catch { /* rejected below */ }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'source_url must be an http or https URL');
  }
  function checklist(items, where, { results = false } = {}) {
    if (!Array.isArray(items) || items.length > 200) throw new HttpError(400, `${where} must be an array of at most 200 items`);
    return items.map((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, `${where}[${i}] must be an object`);
      if (typeof item.done !== 'boolean') throw new HttpError(400, `${where}[${i}].done must be true or false`);
      return {
        text: text(item.text, `${where}[${i}].text`, { max: 4000, required: true }), done: item.done,
        ...(results ? { result: text(item.result, `${where}[${i}].result`, { max: 1000 }) } : {}),
      };
    });
  }
  const assessmentInput = value('assessments', []);
  if (!Array.isArray(assessmentInput) || assessmentInput.length > 60) throw new HttpError(400, 'assessments must be an array of at most 60 groups');
  const assessments = assessmentInput.map((group, i) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new HttpError(400, `assessments[${i}] must be an object`);
    const before = group.before_index;
    if (before !== undefined && (!Number.isInteger(before) || before < 0 || before > routineIds.length)) throw new HttpError(400, `assessments[${i}].before_index is out of range`);
    return {
      title: text(group.title, `assessments[${i}].title`, { max: 200, required: true }),
      ...(before === undefined ? {} : { before_index: before }),
      items: checklist(group.items, `assessments[${i}].items`, { results: true }),
    };
  });
  const progressInput = value('source_progress', []);
  if (!Array.isArray(progressInput) || progressInput.length > 200) throw new HttpError(400, 'source_progress must be an array of at most 200 groups');
  const sourceProgress = progressInput.map((group, i) => {
    if (!group || typeof group !== 'object' || Array.isArray(group) || !routineIds.includes(group.routine_id)) throw new HttpError(400, `source_progress[${i}].routine_id must belong to the program`);
    return { routine_id: group.routine_id, items: checklist(group.items, `source_progress[${i}].items`) };
  });
  if (new Set(sourceProgress.map((group) => group.routine_id)).size !== sourceProgress.length) throw new HttpError(400, 'source_progress must have at most one group per routine');
  if (existing && JSON.stringify(sourceProgress) !== JSON.stringify(existing.source_progress)) throw new HttpError(409, 'imported source_progress cannot be changed');
  if (existing?.completed.some((item) => !routineIds.includes(item.routine_id))) throw new HttpError(409, 'cannot remove completed routines from the program');
  return {
    name: text(value('name', ''), 'name', { max: 200, required: true }),
    notes: text(value('notes', ''), 'notes', { max: 20000 }),
    source_id: text(value('source_id', ''), 'source_id', { max: 200 }), source_url: sourceUrl,
    weekdays: [...new Set(weekdays)].sort((a, b) => a - b), cursor, routine_ids: [...routineIds],
    assessments, source_progress: sourceProgress, prior_completed: [...priorCompleted], completed: existing?.completed || [],
  };
}

// ---------------------------------------------------------------- maths

export function e1rm(weight, reps) {
  if (!weight || !reps) return 0;
  return reps <= 1 ? weight : weight * (1 + reps / 30);
}

// Bests over a list of sets for one exercise kind (warm-ups excluded).
function bests(kind, sets) {
  const out = {};
  for (const s of sets) {
    if (s.kind === 'warmup') continue;
    const up = (key, v) => { if (v && v > (out[key] || 0)) out[key] = v; };
    if (kind === 'weight') {
      up('weight', s.weight_kg);
      up('e1rm', e1rm(s.weight_kg, s.reps));
      up('volume', (s.weight_kg || 0) * (s.reps || 0));
      up('reps', s.reps);
    } else if (kind === 'reps') {
      up('reps', s.reps);
    } else if (kind === 'time') {
      up('time', s.seconds);
    } else {
      up('distance', s.meters);
      up('time', s.seconds);
    }
  }
  return out;
}

function records(kind, sets) {
  const b = bests(kind, sets);
  const work = sets.filter((s) => s.kind !== 'warmup');
  return {
    ...b,
    total_sets: sets.length,
    total_reps: work.reduce((n, s) => n + (s.reps || 0), 0),
    total_volume: kind === 'weight' ? work.reduce((n, s) => n + (s.weight_kg || 0) * (s.reps || 0), 0) : 0,
  };
}

// ---------------------------------------------------------------- data

function workoutRepo(db) {
  const now = () => new Date().toISOString();
  const exRow = (row) => row && ({
    id: Number(row.id), name: row.name, muscle: row.muscle, equipment: row.equipment, kind: row.kind,
    custom: Boolean(row.custom), times: Number(row.times || 0), last_used: row.last_used || null,
  });

  const exList = db.prepare(`
    SELECT e.*, u.times, u.last_used FROM workout_exercises e
    LEFT JOIN (
      SELECT en.exercise_id, COUNT(DISTINCT en.session_id) AS times, MAX(w.started_at) AS last_used
      FROM workout_entries en JOIN workout_sessions w ON w.id = en.session_id GROUP BY en.exercise_id
    ) u ON u.exercise_id = e.id
    ORDER BY e.name COLLATE NOCASE`);
  const exGet = db.prepare('SELECT * FROM workout_exercises WHERE id = ?');
  const exByName = db.prepare('SELECT * FROM workout_exercises WHERE name = ? COLLATE NOCASE');
  const exInsert = db.prepare('INSERT INTO workout_exercises (name, muscle, equipment, kind, custom, created_at) VALUES (?, ?, ?, ?, 1, ?)');
  const exUpdate = db.prepare('UPDATE workout_exercises SET name = ?, muscle = ?, equipment = ?, kind = ? WHERE id = ?');
  const exDelete = db.prepare('DELETE FROM workout_exercises WHERE id = ?');
  const exUsed = db.prepare('SELECT COUNT(DISTINCT session_id) AS n FROM workout_entries WHERE exercise_id = ?');

  const sessionGet = db.prepare('SELECT * FROM workout_sessions WHERE id = ?');
  const sessionsAll = db.prepare('SELECT * FROM workout_sessions ORDER BY started_at DESC, id DESC LIMIT ?');
  const sessionsBefore = db.prepare('SELECT * FROM workout_sessions WHERE started_at < ? ORDER BY started_at DESC, id DESC LIMIT ?');
  const sessionInsert = db.prepare('INSERT INTO workout_sessions (title, notes, routine_id, started_at, ended_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const sessionUpdate = db.prepare('UPDATE workout_sessions SET title = ?, notes = ?, routine_id = ?, started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?');
  const sessionDelete = db.prepare('DELETE FROM workout_sessions WHERE id = ?');
  const entriesFor = db.prepare('SELECT * FROM workout_entries WHERE session_id = ? ORDER BY position');
  const entryInsert = db.prepare('INSERT INTO workout_entries (session_id, exercise_id, position, note, rest, distance_unit) VALUES (?, ?, ?, ?, ?, ?)');
  const entriesDelete = db.prepare('DELETE FROM workout_entries WHERE session_id = ?');
  const setsFor = db.prepare('SELECT * FROM workout_sets WHERE session_id = ? ORDER BY entry_id, position');
  const setInsert = db.prepare('INSERT INTO workout_sets (entry_id, session_id, exercise_id, position, kind, weight_kg, reps, seconds, meters) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const setsDelete = db.prepare('DELETE FROM workout_sets WHERE session_id = ?');
  const priorSets = db.prepare(`
    SELECT s.* FROM workout_sets s JOIN workout_sessions w ON w.id = s.session_id
    WHERE s.exercise_id = ? AND (w.started_at < ? OR (w.started_at = ? AND w.id < ?))`);
  const lastSessionWith = db.prepare(`
    SELECT en.id AS entry_id FROM workout_entries en JOIN workout_sessions w ON w.id = en.session_id
    WHERE en.exercise_id = ? AND en.session_id != ? ORDER BY w.started_at DESC, w.id DESC, en.position DESC LIMIT 1`);
  const setsOfEntry = db.prepare('SELECT * FROM workout_sets WHERE entry_id = ? ORDER BY position');
  const historyStmt = db.prepare(`
    SELECT w.id, w.title, w.started_at, s.kind, s.weight_kg, s.reps, s.seconds, s.meters
    FROM workout_sets s JOIN workout_sessions w ON w.id = s.session_id
    WHERE s.exercise_id = ? ORDER BY w.started_at DESC, w.id DESC, s.entry_id, s.position`);
  const statsStmt = db.prepare(`
    SELECT w.id, w.started_at, w.ended_at,
      COALESCE(SUM(CASE WHEN e.kind = 'weight' THEN COALESCE(s.weight_kg, 0) * COALESCE(s.reps, 0) END), 0) AS volume_kg,
      COUNT(s.id) AS sets
    FROM workout_sessions w
    LEFT JOIN workout_sets s ON s.session_id = w.id
    LEFT JOIN workout_exercises e ON e.id = s.exercise_id
    WHERE w.started_at >= ? GROUP BY w.id ORDER BY w.started_at`);

  const routineAll = db.prepare('SELECT * FROM workout_routines ORDER BY created_at, id');
  const routineGet = db.prepare('SELECT * FROM workout_routines WHERE id = ?');
  const routineInsert = db.prepare('INSERT INTO workout_routines (name, data, created_at, updated_at) VALUES (?, ?, ?, ?)');
  const routineUpdate = db.prepare('UPDATE workout_routines SET name = ?, data = ?, updated_at = ? WHERE id = ?');
  const routineDelete = db.prepare('DELETE FROM workout_routines WHERE id = ?');

  const activeGet = db.prepare('SELECT * FROM workout_active WHERE id = 1');
  const activeSet = db.prepare('INSERT INTO workout_active (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at');
  const activeDelete = db.prepare('DELETE FROM workout_active');
  const programGet = db.prepare('SELECT * FROM workout_program WHERE id = 1');
  const programSet = db.prepare('INSERT INTO workout_program (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at');

  function program() {
    const row = programGet.get();
    if (!row) return null;
    const data = JSON.parse(row.data);
    const assessments = (data.assessments || []).map((group) => ({
      ...group, items: group.items.map((item) => ({ ...item, result: item.result || '' })),
    }));
    return { ...data, assessments, prior_completed: data.prior_completed || [], updated_at: row.updated_at };
  }

  function saveProgram(input) {
    const { updated_at, expected_cursor, expected_updated_at, ...data } = input;
    const previousMs = Date.parse(programGet.get()?.updated_at || '') || 0;
    const stamp = new Date(Math.max(Date.now(), previousMs + 1)).toISOString();
    programSet.run(JSON.stringify(data), stamp);
    return program();
  }

  const setRow = (s) => ({
    kind: s.kind,
    weight_kg: s.weight_kg === null ? null : Number(s.weight_kg),
    reps: s.reps === null ? null : Number(s.reps),
    seconds: s.seconds === null ? null : Number(s.seconds),
    meters: s.meters === null ? null : Number(s.meters),
  });

  const exercise = (id) => exRow(exGet.get(id));

  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  function prsFor(row, entries) {
    const prs = [];
    for (const entry of entries) {
      const prior = priorSets.all(entry.exercise_id, row.started_at, row.started_at, Number(row.id)).map(setRow);
      if (!prior.length) continue;
      const before = bests(entry.kind, prior);
      const now_ = bests(entry.kind, entry.sets);
      for (const [type, value] of Object.entries(now_)) {
        if (value > (before[type] || 0) + 1e-9) prs.push({ exercise_id: entry.exercise_id, type, value });
      }
    }
    return prs;
  }

  function hydrate(row) {
    const exCache = new Map();
    const exOf = (id) => {
      if (!exCache.has(id)) exCache.set(id, exercise(id));
      return exCache.get(id);
    };
    const sets = setsFor.all(row.id);
    const byEntry = new Map();
    for (const s of sets) {
      const key = Number(s.entry_id);
      if (!byEntry.has(key)) byEntry.set(key, []);
      byEntry.get(key).push(setRow(s));
    }
    const exercises = entriesFor.all(row.id).map((en) => {
      const ex = exOf(Number(en.exercise_id)) || { name: 'Deleted exercise', kind: 'weight', muscle: 'Other', equipment: 'Other' };
      return {
        exercise_id: Number(en.exercise_id), name: ex.name, kind: ex.kind, muscle: ex.muscle, equipment: ex.equipment,
        note: en.note, rest: en.rest === null ? null : Number(en.rest), distance_unit: en.distance_unit || '', sets: byEntry.get(Number(en.id)) || [],
      };
    });
    let volume = 0;
    let setCount = 0;
    for (const ex of exercises) {
      setCount += ex.sets.length;
      if (ex.kind === 'weight') for (const s of ex.sets) volume += (s.weight_kg || 0) * (s.reps || 0);
    }
    return {
      id: Number(row.id), title: row.title, notes: row.notes, routine_id: row.routine_id === null ? null : Number(row.routine_id),
      started_at: row.started_at, ended_at: row.ended_at,
      seconds: Math.max(0, Math.round((Date.parse(row.ended_at) - Date.parse(row.started_at)) / 1000)),
      volume_kg: Math.round(volume * 10) / 10, set_count: setCount,
      prs: prsFor(row, exercises), exercises,
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }

  function routineOut(row) {
    let data = { exercises: [] };
    try { data = JSON.parse(row.data); } catch { /* keep empty */ }
    const exercises = (data.exercises || []).map((en) => {
      const ex = exercise(en.exercise_id);
      return ex ? { ...en, prescription: en.prescription || '', distance_unit: en.distance_unit || '', name: ex.name, kind: ex.kind, muscle: ex.muscle, equipment: ex.equipment } : null;
    }).filter(Boolean);
    return {
      id: Number(row.id), name: row.name, notes: data.notes || '', weekdays: data.weekdays || [],
      source_id: data.source_id || '', source_url: data.source_url || '', exercises,
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }

  return {
    exercises: () => exList.all().map(exRow),
    exercise,
    exerciseByName: (name) => exRow(exByName.get(name)),
    createExercise({ name, muscle, equipment, kind }) {
      const info = exInsert.run(name, muscle, equipment, kind, now());
      return exercise(Number(info.lastInsertRowid));
    },
    updateExercise(ex) {
      exUpdate.run(ex.name, ex.muscle, ex.equipment, ex.kind, ex.id);
      return exercise(ex.id);
    },
    deleteExercise: (id) => exDelete.run(id),
    timesUsed: (id) => Number(exUsed.get(id).n),
    routinesUsing: (id) => routineAll.all().filter((row) => {
      try { return JSON.parse(row.data).exercises.some((e) => e.exercise_id === id); } catch { return false; }
    }).length,
    exerciseHistory(id) {
      const out = [];
      let cur = null;
      for (const row of historyStmt.all(id)) {
        if (!cur || cur.id !== Number(row.id)) {
          cur = { id: Number(row.id), title: row.title, started_at: row.started_at, sets: [] };
          out.push(cur);
        }
        cur.sets.push(setRow(row));
      }
      return out;
    },
    previousSets(exerciseId, excludeSession) {
      const hit = lastSessionWith.get(exerciseId, excludeSession || 0);
      return hit ? setsOfEntry.all(hit.entry_id).map(setRow) : [];
    },
    sessionRows: ({ before, limit }) => (before ? sessionsBefore.all(before, limit) : sessionsAll.all(limit)),
    hydrate,
    session(id) {
      const row = sessionGet.get(id);
      return row ? hydrate(row) : null;
    },
    saveSession(id, input) {
      const ts = now();
      const sessionId = tx(() => {
        let sid = id;
        if (sid) {
          sessionUpdate.run(input.title, input.notes, input.routine_id, input.started_at, input.ended_at, ts, sid);
          setsDelete.run(sid);
          entriesDelete.run(sid);
        } else {
          sid = Number(sessionInsert.run(input.title, input.notes, input.routine_id, input.started_at, input.ended_at, ts, ts).lastInsertRowid);
        }
        input.exercises.forEach((ex, i) => {
          const entryId = Number(entryInsert.run(sid, ex.exercise_id, i, ex.note, ex.rest, ex.distance_unit).lastInsertRowid);
          ex.sets.forEach((s, j) => setInsert.run(entryId, sid, ex.exercise_id, j, s.kind, s.weight_kg, s.reps, s.seconds, s.meters));
        });
        if (!id) {
          const current = program();
          if (current && current.routine_ids[current.cursor] === input.routine_id && input.advance_program !== false) {
            const routine = routineOut(routineGet.get(input.routine_id));
            const logged = new Map();
            for (const ex of input.exercises) logged.set(ex.exercise_id, (logged.get(ex.exercise_id) || 0) + ex.sets.length);
            const planned = new Map();
            for (const ex of routine.exercises) planned.set(ex.exercise_id, (planned.get(ex.exercise_id) || 0) + Math.max(1, ex.sets.length));
            const coversPlan = [...planned].every(([exerciseId, count]) => (logged.get(exerciseId) || 0) >= count);
            if (input.advance_program !== true && !coversPlan) return sid;
            current.completed = current.completed.filter((item) => item.routine_id !== input.routine_id);
            current.completed.push({ routine_id: input.routine_id, session_id: sid });
            current.cursor += 1;
            saveProgram(current);
          }
        }
        return sid;
      });
      return this.session(sessionId);
    },
    deleteSession(id) {
      return tx(() => {
        setsDelete.run(id);
        entriesDelete.run(id);
        const deleted = Number(sessionDelete.run(id).changes) > 0;
        const current = program();
        if (deleted && current?.completed.some((item) => item.session_id === id)) {
          current.completed = current.completed.filter((item) => item.session_id !== id);
          saveProgram(current);
        }
        return deleted;
      });
    },
    stats: (since) => statsStmt.all(since).map((row) => ({
      id: Number(row.id), started_at: row.started_at,
      seconds: Math.max(0, Math.round((Date.parse(row.ended_at) - Date.parse(row.started_at)) / 1000)),
      volume_kg: Math.round(Number(row.volume_kg) * 10) / 10, sets: Number(row.sets),
    })),
    routines: () => routineAll.all().map(routineOut),
    routine(id) {
      const row = routineGet.get(id);
      return row ? routineOut(row) : null;
    },
    saveRoutine(id, input) {
      const data = JSON.stringify({
        exercises: input.exercises, notes: input.notes, weekdays: input.weekdays,
        source_id: input.source_id, source_url: input.source_url,
      });
      const ts = now();
      let rid = id;
      if (rid) routineUpdate.run(input.name, data, ts, rid);
      else rid = Number(routineInsert.run(input.name, data, ts, ts).lastInsertRowid);
      return this.routine(rid);
    },
    deleteRoutine: (id) => Number(routineDelete.run(id).changes) > 0,
    program,
    saveProgram,
    active() {
      const row = activeGet.get();
      if (!row) return { active: null, updated_at: null };
      try { return { active: JSON.parse(row.data), updated_at: row.updated_at }; } catch { return { active: null, updated_at: null }; }
    },
    setActive(obj) {
      const ts = now();
      activeSet.run(JSON.stringify(obj), ts);
      return ts;
    },
    clearActive: () => activeDelete.run(),
  };
}
