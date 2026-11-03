// Ordered training programs. Imported checklists remain distinct from logged sessions.
import { api, el, fmt, icon, toast, holdReload, releaseReload } from '../../kit.js';
import { formSheet } from '../../form.js';
import { fmtClock, setText } from './lib.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let savingProgram = false;

export function programView({ program, routines, active, previewIndex, onPreview, onChange, onStart, nav }) {
  const byId = new Map(routines.map((r) => [r.id, r]));
  const count = program.routine_ids.length;
  const index = Math.min(previewIndex ?? program.cursor, count - 1);
  const routine = byId.get(program.routine_ids[index]);
  const isCurrent = index === program.cursor;
  const isDone = program.cursor === count;
  const today = new Date();
  const scheduled = !program.weekdays.length || program.weekdays.includes(today.getDay());
  const imported = program.source_progress.find((p) => p.routine_id === routine?.id);
  const completed = program.completed.find((c) => c.routine_id === routine?.id);
  const priorCompleted = (program.prior_completed || []).includes(routine?.id);
  const inProgress = active?.routine_id === routine?.id;
  let container;

  async function update(patch, button) {
    if (savingProgram) return;
    savingProgram = true;
    holdReload('workout:program-save');
    container?.querySelectorAll('button, input, select').forEach((control) => { control.disabled = true; });
    let nextProgram = program;
    try {
      const result = await api('/api/workout/program', { method: 'PATCH', body: { ...patch, expected_updated_at: program.updated_at } });
      nextProgram = result.program;
    } catch (err) {
      toast(err.status === 409 ? 'Your program changed on another screen. Review the latest version and try again.' : `Couldn’t update program: ${err.message}`, { kind: 'error' });
      if (err.status === 409) {
        const fresh = await api('/api/workout/program').catch(() => null);
        nextProgram = fresh?.program || program;
      }
    } finally {
      savingProgram = false;
      releaseReload('workout:program-save');
      onChange(nextProgram);
    }
  }

  const select = el('select', { class: 'wo-program-select', 'aria-label': 'Preview a program workout' },
    ...program.routine_ids.map((id, i) => el('option', { value: String(i), text: `${byId.get(id)?.name || 'Unavailable routine'}${i === program.cursor ? ' · Up next' : ''}` })));
  select.value = String(index);
  select.addEventListener('change', () => onPreview(Number(select.value)));

  const trainingLabel = program.weekdays.length ? program.weekdays.map((d) => DAYS[d]).join(' · ') : 'Workouts advance when you finish';
  const schedule = el('details', { class: 'wo-program-notes wo-program-settings' },
    el('summary', { text: trainingLabel }),
    el('p', { class: 'muted', text: 'Choose training days, or leave all off to follow the next workout whenever you train. Missed days never skip a workout.' }),
    el('div', { class: 'wo-weekdays', role: 'group', 'aria-label': 'Program training days' },
      ...[1, 2, 3, 4, 5, 6, 0].map((day) => el('button', {
        type: 'button', class: 'wo-weekday', text: DAYS[day], 'aria-pressed': String(program.weekdays.includes(day)),
        'on:click': (event) => update({ weekdays: program.weekdays.includes(day) ? program.weekdays.filter((d) => d !== day) : [...program.weekdays, day] }, event.currentTarget),
      }))));

  const heading = isDone ? 'Program complete' : scheduled ? 'Your next workout' : `Rest day · next workout ${nextTrainingDay(program.weekdays, today)}`;
  const out = [
    el('div', { class: 'wo-program-header' },
      el('div', { class: 'wo-program-date muted', text: fmt.date(today, { weekday: 'long', month: 'long' }) }),
      el('h2', { text: program.name }),
      el('div', { class: 'muted', text: heading }),
      el('div', { class: 'muted', text: `${program.prior_completed?.length || 0} completed before import · ${program.completed.length} logged here` })),
    schedule,
    el('label', { class: 'wo-program-picker' }, el('span', { text: 'Program workout' }), select),
  ];

  if (routine) {
    const start = el('button', {
      type: 'button', class: 'wo-btn wo-btn-primary',
      text: inProgress ? 'Resume Workout' : isCurrent ? 'Start Workout' : 'Make This My Next Workout',
      'on:click': (event) => {
        if (inProgress) nav.go('#/workout/active');
        else if (isCurrent) onStart(routine);
        else update({ cursor: index, expected_cursor: program.cursor }, event.currentTarget);
      },
    });
    const assessments = program.assessments.filter((group) => group.before_index === index);
    out.push(el('section', { class: 'card wo-plan' },
      el('div', { class: 'wo-plan-heading' }, el('h2', { text: routine.name }),
        completed || priorCompleted ? el('span', { class: 'wo-plan-complete', text: completed ? 'Logged' : 'Completed before import' }) : null),
      el('div', { class: 'muted wo-plan-meta', text: `Workout ${index + 1} of ${count} · ${routine.exercises.length} exercises` }),
      routine.notes ? el('p', { class: 'wo-program-instructions', text: routine.notes }) : null,
      ...assessments.map(assessmentCard),
      start,
      !isCurrent ? el('p', { class: 'muted wo-plan-note', text: 'Previewing this workout. Your program position changes only when you choose it.' }) : null,
      el('ol', { class: 'wo-plan-exercises' }, ...routine.exercises.map((ex) => el('li', {},
        el('div', { class: 'wo-plan-ex-name', text: ex.name }),
        el('div', { class: 'wo-plan-prescription', text: ex.prescription || targetSummary(ex) }),
        ex.note ? el('div', { class: 'muted wo-plan-note', text: ex.note }) : null,
        ex.rest ? el('div', { class: 'muted wo-plan-rest', text: `Rest ${fmtClock(ex.rest)}` }) : null))),
      imported ? el('details', { class: 'wo-program-notes' },
        el('summary', { text: `Original Notion checklist · ${imported.items.filter((x) => x.done).length}/${imported.items.length}` }),
        el('p', { class: 'muted', text: 'Snapshot only. Your confirmed program progress is shown above; new sets are recorded separately.' }),
        ...imported.items.map((item) => el('div', { class: 'wo-source-check' },
          el('span', { class: 'wo-source-state', 'aria-label': item.done ? 'Checked in Notion' : 'Unchecked in Notion' }, item.done ? icon('check', { size: 16 }) : '—'),
          el('span', { text: item.text })))) : null,
      el('button', { type: 'button', class: 'wo-link', text: 'Edit Routine', 'on:click': () => nav.go(`#/workout/r/${routine.id}`) }),
      completed ? el('button', { type: 'button', class: 'wo-link', text: 'View Logged Workout', 'on:click': () => nav.go(`#/workout/s/${completed.session_id}`) }) : null));
  }

  out.push(el('details', { class: 'card wo-plan wo-program-notes' },
    el('summary', { text: 'Assessments & original program' }),
    ...program.assessments.map(assessmentCard),
    program.notes ? el('p', { text: program.notes }) : null,
    program.source_url ? el('a', { class: 'wo-plan-source', href: program.source_url, target: '_blank', rel: 'noopener noreferrer', text: 'Open Original Notion Program' }) : null));
  container = el('div', { class: 'wo-program' }, ...out);
  if (savingProgram) container.querySelectorAll('button, input, select').forEach((control) => { control.disabled = true; });
  return container;

  function assessmentCard(group) {
    return el('section', { class: 'wo-assessment' },
      el('h3', { text: group.title }),
      ...group.items.map((item, itemIndex) => {
        const check = el('input', { type: 'checkbox', 'aria-label': item.text });
        check.checked = item.done;
        check.addEventListener('change', async () => {
          const assessments = program.assessments.map((g) => g === group ? { ...g, items: g.items.map((x, i) => i === itemIndex ? { ...x, done: check.checked } : x) } : g);
          check.disabled = true;
          await update({ assessments }, check);
        });
        const resultButton = el('button', { type: 'button', class: 'wo-link wo-assessment-result', text: item.result ? `Result: ${item.result}` : 'Add result',
          'on:click': async () => {
            if (savingProgram) return;
            const result = await formSheet({ title: 'Assessment result', fields: [{ key: 'result', label: item.text, type: 'textarea', value: item.result || '', placeholder: 'Time, measurement, or observation' }] });
            if (!result || result === 'delete') return;
            const assessments = program.assessments.map((g) => g === group ? { ...g, items: g.items.map((x, i) => i === itemIndex ? { ...x, result: result.result } : x) } : g);
            await update({ assessments }, resultButton);
          },
        });
        return el('div', { class: 'wo-assessment-entry' },
          el('label', { class: 'wo-assessment-item' }, check, el('span', { text: item.text })), resultButton);
      }));
  }
}

function targetSummary(ex) {
  const sets = ex.sets.map((s) => setText(ex.kind, s, ex.distance_unit));
  return sets.every((s) => s === sets[0]) ? `${sets.length} × ${sets[0] || 'Log your set'}` : sets.join(' · ');
}

function nextTrainingDay(weekdays, today) {
  for (let offset = 1; offset <= 7; offset += 1) {
    if (weekdays.includes((today.getDay() + offset) % 7)) return DAYS[(today.getDay() + offset) % 7];
  }
  return '';
}
