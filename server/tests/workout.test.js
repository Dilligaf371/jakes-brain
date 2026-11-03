import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openDb } from '../db.js';
import { createRouter } from '../router.js';
import workout from '../apps/workout.js';
import { draftSet, serverSet, draftExercise } from '../../web/apps/workout/lib.js';
import { newActiveDraft, draftFromRoutine, hasRemainingProgramSets } from '../../web/apps/workout/logger.js';

test('workout plans retain schedule, exact prescriptions and source through edits and logging', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workout-plan-test-'));
  const store = openDb(dir);
  store.applyMigrations('workout', workout.migrations);
  const router = createRouter({ log: { error() {} } });
  workout.register(router, { db: store.db });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function call(route, method = 'GET', body) {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    request.method = method;
    request.url = '/api/workout' + route;
    request.headers = { 'content-type': 'application/json' };
    const response = {
      headersSent: false, writableEnded: false, status: null, payload: null,
      writeHead(status) { this.status = status; this.headersSent = true; },
      end(payload) { this.payload = payload; this.writableEnded = true; },
    };
    assert.equal(await router.handle(request, response, new URL(request.url, 'http://localhost')), true);
    return { status: response.status, body: response.payload ? JSON.parse(response.payload) : null };
  }
  const library = (await call('/exercises')).body.exercises;
  const bench = library.find((ex) => ex.name === 'Bench Press (Barbell)');
  const cardio = library.find((ex) => ex.kind === 'cardio');
  const plan = {
    name: 'Test upper body', notes: 'Warm up first.\nLeave two reps in reserve.', weekdays: [4, 1],
    source_id: 'test:source-routine', source_url: 'https://example.org/original-plan',
    exercises: [
      { exercise_id: bench.id, rest: 120, note: 'Controlled lowering', prescription: '3 × 8–12 reps', sets: [{}, {}, {}] },
      { exercise_id: cardio.id, rest: 0, note: '', prescription: '20–30 min easy pace', sets: [{}] },
    ],
  };
  const created = await call('/routines', 'POST', plan);
  assert.equal(created.status, 201);
  const id = created.body.routine.id;
  assert.deepEqual(created.body.routine.weekdays, [1, 4]);
  assert.equal(created.body.routine.notes, plan.notes);
  assert.equal(created.body.routine.source_id, plan.source_id);
  assert.equal(created.body.routine.source_url, plan.source_url);
  assert.deepEqual(created.body.routine.exercises.map((ex) => ex.exercise_id), [bench.id, cardio.id]);
  assert.equal(created.body.routine.exercises[0].prescription, '3 × 8–12 reps');
  assert.equal(created.body.routine.exercises[0].sets[0].reps, null, 'a target range is never converted to completed reps');

  await t.test('older clients do not erase new metadata', async () => {
    const olderPayload = { name: 'Renamed plan', exercises: plan.exercises.map(({ prescription, ...ex }) => ex) };
    const result = await call(`/routines/${id}`, 'PUT', olderPayload);
    assert.equal(result.status, 200);
    assert.equal(result.body.routine.name, 'Renamed plan');
    assert.deepEqual(result.body.routine.weekdays, [1, 4]);
    assert.equal(result.body.routine.notes, plan.notes);
    assert.equal(result.body.routine.source_url, plan.source_url);
    assert.equal(result.body.routine.exercises[0].prescription, '3 × 8–12 reps');
    assert.equal(result.body.routine.exercises[1].prescription, '20–30 min easy pace');
  });

  await t.test('metadata and prescriptions can be explicitly changed or cleared', async () => {
    const edited = { ...plan, weekdays: [], notes: '', source_id: '', source_url: '', exercises: plan.exercises.map((ex) => ({ ...ex, prescription: '' })) };
    const result = await call(`/routines/${id}`, 'PUT', edited);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.routine.weekdays, []);
    for (const key of ['notes', 'source_id', 'source_url']) assert.equal(result.body.routine[key], '');
    assert.equal(result.body.routine.exercises[0].prescription, '');
  });

  await t.test('invalid schedules and source links fail before modifying data', async () => {
    for (const weekdays of [null, 'Monday', [7], [-1], [1.5], ['1']]) {
      assert.equal((await call(`/routines/${id}`, 'PUT', { ...plan, weekdays })).status, 400);
    }
    for (const source_url of ['javascript:alert(1)', '/relative', 'file:///tmp/plan']) {
      assert.equal((await call(`/routines/${id}`, 'PUT', { ...plan, source_url })).status, 400);
    }
    const result = await call('/routines');
    assert.deepEqual(result.body.routines.find((r) => r.id === id).weekdays, []);
  });

  await t.test('legacy routines have stable defaults', async () => {
    const stamp = new Date().toISOString();
    const legacy = store.db.prepare('INSERT INTO workout_routines (name, data, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('Legacy routine', JSON.stringify({ exercises: [{ exercise_id: bench.id, rest: 90, sets: [] }] }), stamp, stamp);
    const routine = (await call('/routines')).body.routines.find((r) => r.id === Number(legacy.lastInsertRowid));
    assert.deepEqual(routine.weekdays, []);
    for (const key of ['notes', 'source_id', 'source_url']) assert.equal(routine[key], '');
    assert.equal(routine.exercises[0].prescription, '');
  });

  await t.test('session retains source prescription beside actual logged sets and survives editing', async () => {
    const payload = {
      title: plan.name, notes: plan.notes, routine_id: id,
      started_at: '2026-11-03T12:00:00Z', ended_at: '2026-11-03T13:00:00Z',
      exercises: [
        { ...plan.exercises[0], sets: [{ weight_kg: 50, reps: 9 }] },
        { ...plan.exercises[1], sets: [{ seconds: 1320 }] },
      ],
    };
    const logged = await call('/sessions', 'POST', payload);
    assert.equal(logged.status, 201);
    const session = logged.body.session;
    assert.equal(session.exercises[0].note, 'Prescription: 3 × 8–12 reps\n\nControlled lowering');
    assert.equal(session.exercises[0].sets[0].reps, 9);
    assert.equal(session.exercises[1].sets[0].seconds, 1320);
    assert.equal(session.exercises[1].note, 'Prescription: 20–30 min easy pace');
    assert.equal((await call(`/sessions/${session.id}`, 'PUT', session)).body.session.exercises[0].note, session.exercises[0].note);
  });

  await t.test('short-distance targets and unspecified rest survive routine editing and logging', async () => {
    for (const [meters, unit, displayed] of [[18.288, 'yd', '20'], [36.576, 'yd', '40'], [250, 'm', '250'], [18.288, '', '0.011364']]) {
      const set = draftSet({ kind: 'normal', meters }, false, unit);
      assert.equal(set.d, displayed);
      assert.equal(serverSet('cardio', set, 'lb', unit).meters, meters, 'unchanged distance retains canonical meters exactly');
    }
    const changed = draftSet({ meters: 18.288 }, false, 'yd');
    changed.d = '21';
    assert.equal(serverSet('cardio', changed, 'lb', 'yd').meters, 19.202, 'an edited distance uses the exercise unit');
    const response = await call('/routines', 'POST', {
      name: 'Short-distance routine', exercises: [{ exercise_id: cardio.id, distance_unit: 'yd', rest: null, sets: [{ meters: 18.288 }] }],
    });
    const routine = response.body.routine;
    assert.equal(routine.exercises[0].distance_unit, 'yd');
    const edit = draftFromRoutine(routine);
    const activeDraft = newActiveDraft({ routine, program: true });
    for (const draft of [edit, activeDraft]) {
      assert.equal(draft.exercises[0].rest, 0, 'imported unspecified rest does not add an automatic timer');
      assert.equal(draft.exercises[0].sets[0].d, '20');
      assert.equal(serverSet('cardio', draft.exercises[0].sets[0], draft.unit, 'yd').meters, 18.288);
    }
    assert.equal(draftExercise(bench, []).rest, 90, 'new manually added strength exercises keep existing default rest');
    assert.equal(hasRemainingProgramSets(activeDraft), true);
    activeDraft.exercises[0].sets[0].done = true;
    assert.equal(hasRemainingProgramSets(activeDraft), false);
    activeDraft.exercises = [];
    assert.equal(hasRemainingProgramSets(activeDraft), true, 'removing a planned exercise still requires a skip decision');
    const result = await call('/sessions', 'POST', {
      title: 'Short-distance log', started_at: '2026-11-03T12:00:00Z', ended_at: '2026-11-03T12:30:00Z',
      exercises: [{ exercise_id: cardio.id, distance_unit: 'yd', rest: 0, sets: [{ meters: 18.288 }] }],
    });
    assert.equal(result.body.session.exercises[0].distance_unit, 'yd');
    assert.equal(result.body.session.exercises[0].sets[0].meters, 18.288);
  });

  await t.test('ordered program keeps imported progress separate and advances atomically only for its current routine', async () => {
    assert.equal((await call('/program')).body.program, null);
    const routineIds = [];
    for (const name of ['Sequence A', 'Sequence B', 'Sequence C']) {
      const response = await call('/routines', 'POST', { ...plan, name, weekdays: [] });
      routineIds.push(response.body.routine.id);
    }
    const sourceProgress = routineIds.map((routine_id, i) => ({
      routine_id, items: Array.from({ length: 180 }, (_, j) => ({ text: `Source step ${i + 1}.${j + 1} · exact 8–12 range`, done: j < 10 })),
    }));
    const original = {
      name: 'Ordered test program', routine_ids: routineIds, cursor: 1, weekdays: [],
      notes: 'Follow the source order; dates are unknown.', source_url: 'https://example.org/program',
      assessments: [{ title: 'Baseline', before_index: 0, items: [{ text: 'Hold result: 1:30', done: true }] }],
      source_progress: sourceProgress, prior_completed: [routineIds[0]],
    };
    const sessionCount = store.db.prepare('SELECT COUNT(*) AS n FROM workout_sessions').get().n;
    const initial = await call('/program', 'PUT', original);
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.program.source_progress, sourceProgress);
    assert.deepEqual(initial.body.program.completed, []);
    assert.equal(initial.body.program.assessments[0].items[0].result, '');
    assert.deepEqual(initial.body.program.prior_completed, [routineIds[0]]);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workout_sessions').get().n, sessionCount, 'imported checkmarks create no logged sessions');
    const active = { title: 'Existing draft', exercises: [], started_at: '2026-11-03T11:00:00Z' };
    await call('/active', 'PUT', { active });

    const jumped = await call('/program', 'PATCH', { cursor: 2, expected_cursor: 1, expected_updated_at: initial.body.program.updated_at, weekdays: [5, 1] });
    assert.equal(jumped.body.program.cursor, 2);
    assert.deepEqual(jumped.body.program.weekdays, [1, 5]);
    assert.deepEqual(jumped.body.program.source_progress, sourceProgress);
    assert.deepEqual(jumped.body.program.prior_completed, [routineIds[0]], 'cursor changes retain confirmed pre-import completion');
    assert.ok(Date.parse(jumped.body.program.updated_at) > Date.parse(initial.body.program.updated_at), 'program version increases on every save');
    assert.equal((await call('/program', 'PATCH', { assessments: [], expected_updated_at: initial.body.program.updated_at })).status, 409);
    assert.deepEqual((await call('/program')).body.program.assessments, jumped.body.program.assessments, 'stale assessment update cannot erase current data');
    assert.equal((await call('/program', 'PATCH', { cursor: 0, expected_cursor: 1 })).status, 409);
    assert.equal((await call('/program')).body.program.cursor, 2);
    assert.deepEqual((await call('/active')).body.active, active);
    for (const invalid of [{ cursor: -1 }, { cursor: 4 }, { cursor: 1.5 }, { weekdays: [7] }, { source_progress: [] }]) {
      assert.equal((await call('/program', 'PATCH', invalid)).status, 400);
    }
    for (const routine_ids of [[], [routineIds[0], routineIds[0]], [999999]]) {
      assert.equal((await call('/program', 'PUT', { ...original, routine_ids })).status, 400);
    }
    for (const prior_completed of [[999999], [routineIds[0], routineIds[0]], null]) {
      assert.equal((await call('/program', 'PUT', { prior_completed })).status, 400);
    }
    assert.equal((await call('/program', 'PUT', { ...original, source_progress: [] })).status, 409);
    const changedAssessments = [{ title: 'Baseline', before_index: 0, items: [{ text: 'Hold result: 1:30', done: true, result: 'Retest: 1:45. Comfortable.' }] }];
    assert.equal((await call('/program', 'PATCH', { assessments: changedAssessments })).status, 200);
    assert.deepEqual((await call('/program')).body.program.assessments, changedAssessments);
    assert.deepEqual((await call('/program')).body.program.source_progress, sourceProgress);
    const overlongResult = [{ ...changedAssessments[0], items: [{ ...changedAssessments[0].items[0], result: 'x'.repeat(1001) }] }];
    assert.equal((await call('/program', 'PATCH', { assessments: overlongResult })).status, 400);
    assert.deepEqual((await call('/program')).body.program.assessments, changedAssessments);

    await call('/program', 'PATCH', { cursor: 0 });
    assert.deepEqual((await call('/program')).body.program.assessments, changedAssessments, 'cursor changes preserve measured results');
    const sessionInput = (routine_id) => ({
      title: 'Logged sequence session', routine_id, started_at: '2026-11-03T12:00:00Z', ended_at: '2026-11-03T12:30:00Z',
      exercises: [
        { exercise_id: bench.id, sets: Array.from({ length: 3 }, () => ({ weight_kg: 40, reps: 10 })) },
        { exercise_id: cardio.id, sets: [{ seconds: 1200 }] },
      ],
    });
    await call('/sessions', 'POST', sessionInput(routineIds[2]));
    assert.equal((await call('/program')).body.program.cursor, 0, 'unrelated routine does not advance');
    const partial = { ...sessionInput(routineIds[0]), exercises: [{ exercise_id: bench.id, sets: [{ weight_kg: 40, reps: 10 }] }] };
    await call('/sessions', 'POST', partial);
    assert.equal((await call('/program')).body.program.cursor, 0, 'partial routine does not advance without explicit confirmation');
    await call('/sessions', 'POST', { ...sessionInput(routineIds[0]), advance_program: false });
    assert.equal((await call('/program')).body.program.cursor, 0, 'explicit partial save keeps current position');
    const loggedA = (await call('/sessions', 'POST', sessionInput(routineIds[0]))).body.session;
    let current = (await call('/program')).body.program;
    assert.equal(current.cursor, 1);
    assert.deepEqual(current.completed, [{ routine_id: routineIds[0], session_id: loggedA.id }]);
    await call('/sessions', 'POST', sessionInput(routineIds[0]));
    assert.equal((await call('/program')).body.program.cursor, 1, 'repeated save cannot advance another routine');
    await call(`/sessions/${loggedA.id}`, 'PUT', sessionInput(routineIds[1]));
    assert.equal((await call('/program')).body.program.cursor, 1, 'editing a session never advances');
    await call('/sessions', 'POST', sessionInput(routineIds[1]));
    assert.equal((await call('/program')).body.program.cursor, 2);
    await call('/program', 'PATCH', { cursor: 0 });
    const repeatedA = (await call('/sessions', 'POST', { ...partial, advance_program: true })).body.session;
    current = (await call('/program')).body.program;
    assert.equal(current.cursor, 1, 'replaying a routine selected as current advances normally');
    assert.equal(current.completed.length, 2);
    assert.equal(current.completed.find((entry) => entry.routine_id === routineIds[0]).session_id, repeatedA.id, 'replay updates one completion link instead of adding a duplicate');

    await call('/program', 'PATCH', { cursor: 2 });
    const beforeFailure = store.db.prepare('SELECT COUNT(*) AS n FROM workout_sessions').get().n;
    store.db.exec("CREATE TRIGGER fail_program_save BEFORE UPDATE ON workout_program BEGIN SELECT RAISE(ABORT, 'simulated program save failure'); END");
    assert.equal((await call('/sessions', 'POST', sessionInput(routineIds[2]))).status, 500);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workout_sessions').get().n, beforeFailure, 'program failure rolls the session back');
    assert.equal((await call('/program')).body.program.cursor, 2);
    store.db.exec('DROP TRIGGER fail_program_save');
    const loggedC = (await call('/sessions', 'POST', sessionInput(routineIds[2]))).body.session;
    current = (await call('/program')).body.program;
    assert.equal(current.cursor, 3, 'last routine completes program');
    assert.equal(current.completed.length, 3);
    assert.equal(current.completed[2].session_id, loggedC.id);
    assert.deepEqual(current.source_progress, sourceProgress);
    assert.deepEqual((await call('/active')).body.active, active, 'program changes and saves never modify active draft');
    assert.equal((await call(`/routines/${routineIds[0]}`, 'DELETE')).status, 409, 'program references cannot become dangling');
    const forged = await call('/program', 'PUT', { completed: [{ routine_id: routineIds[0], session_id: 999999 }] });
    assert.deepEqual(forged.body.program.completed, current.completed, 'completion history is server-owned');
    assert.deepEqual(forged.body.program.prior_completed, [routineIds[0]]);
    assert.equal((await call(`/sessions/${loggedC.id}`, 'DELETE')).status, 204);
    const afterDelete = (await call('/program')).body.program;
    assert.equal(afterDelete.cursor, 3, 'deleting a session does not guess a new program position');
    assert.equal(afterDelete.completed.some((entry) => entry.session_id === loggedC.id), false, 'deleted session links are removed');
    assert.deepEqual(afterDelete.prior_completed, [routineIds[0]]);
  });
});
