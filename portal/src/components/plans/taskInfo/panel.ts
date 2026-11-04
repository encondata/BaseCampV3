/**
 * What each Task Information tab (components/plans/TaskInfoModal) gets:
 * the plan and task, the form and its setter, the errors by field, which
 * fields this person may change now (`can`: false while OK is on its way
 * too) and the plan calendar's units.
 */
import type { Plan, PlanTask } from '../../../lib/plans/api';
import type { Units } from '../../../lib/plans/durations';
import type { InfoField, TaskInfoErrors, TaskInfoForm } from '../../../lib/plans/taskInfo';

export interface PanelProps {
  plan: Plan;
  task: PlanTask;
  form: TaskInfoForm;
  set(patch: Partial<TaskInfoForm>): void;
  errors: TaskInfoErrors;
  can(field: InfoField): boolean;
  units: Units;
}

/** A field's error id, for aria-describedby. */
export const errorId = (field: string) => `pln-ti-${field.replace(/[^a-z0-9]+/gi, '-')}-error`;

/** The input type of a plan date: with its time when the plan shows times. */
export const dateType = (plan: Plan) => (plan.settings.show_times ? 'datetime-local' : 'date');
