/**
 * The Indicators column (MS Project's "i" column): which icons a task shows
 * and the tooltip each carries. Pure: everything comes from the task as the
 * API sent it (the portal never decides a schedule state of its own).
 */
import type { ConstraintType, PlanTask } from './api';
import { formatCell } from './floatingTime';

export type IndicatorKind = 'complete' | 'constraint' | 'conflict' | 'deadline' | 'note' | 'locked';

export interface Indicator {
  kind: IndicatorKind;
  /** The tooltip, also the icon's accessible name. */
  title: string;
}

export interface IndicatorContext {
  showTimes: boolean;      // the plan's Show times setting
  locked: boolean;         // the plan's schedule is locked
}

/** MS Project's names for the constraint types. */
export const CONSTRAINT_LABELS: Record<ConstraintType, string> = {
  asap: 'As Soon As Possible',
  snet: 'Start No Earlier Than',
  snlt: 'Start No Later Than',
  fnet: 'Finish No Earlier Than',
  fnlt: 'Finish No Later Than',
  mso: 'Must Start On',
  mfo: 'Must Finish On',
};

export const LOCKED_TITLE = 'Schedule locked — progress updates only';
const NOTE_CHARS = 200;

/** Text on one line: runs of whitespace (newlines too) become one space. */
export function oneLine(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function completeTitle(task: PlanTask, showTimes: boolean): string {
  // summaries are never stamped: their "complete" is their % alone
  const when = task.actual_finish ? ` ${formatCell(task.actual_finish, showTimes)}` : '';
  const who = task.completed_by_name ? ` by ${task.completed_by_name}` : '';
  return when || who ? `Completed${when}${who}` : 'Complete';
}

/** The task's indicators in display order: complete, constraint, conflict,
 *  missed deadline, note, locked. */
export function indicatorsOf(task: PlanTask, ctx: IndicatorContext): Indicator[] {
  const day = (s: string | null) => formatCell(s, ctx.showTimes);
  const out: Indicator[] = [];
  if (task.percent_complete >= 100) out.push({ kind: 'complete', title: completeTitle(task, ctx.showTimes) });
  if (task.constraint_type !== 'asap') {
    const date = day(task.constraint_date);
    out.push({ kind: 'constraint', title: `${CONSTRAINT_LABELS[task.constraint_type]}${date ? ` ${date}` : ''}` });
  }
  if (task.conflict === 'link') {
    out.push({ kind: 'conflict', title: 'Scheduling conflict: the constraint overrides a link' });
  } else if (task.conflict === 'constraint') {
    out.push({ kind: 'conflict', title: 'Scheduling conflict: a link overrides the constraint' });
  }
  if (task.missed_deadline) {
    out.push({
      kind: 'deadline',
      title: `Missed deadline: finishes ${day(task.finish)}, deadline ${day(task.deadline)}`,
    });
  }
  const note = oneLine(task.notes);
  if (note) {
    const shown = note.length > NOTE_CHARS ? `${note.slice(0, NOTE_CHARS).trimEnd()}…` : note;
    out.push({ kind: 'note', title: `Notes: ${shown}` });
  }
  if (ctx.locked) out.push({ kind: 'locked', title: LOCKED_TITLE });
  return out;
}
