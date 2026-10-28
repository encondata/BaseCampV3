/**
 * What a plan write answers its caller (PlanController.apply and friends).
 * The completion 409s become their own kinds, which the completion dialog
 * reads; any other failure is a plain-language message with its code and
 * the tasks it names, so the sheet can show it by the cell it is about.
 */
import type { CompletionBlocker, Notice, Op } from './api';
import { planErrorDetail, planErrorText } from './errors';

export type ApplyResult =
  /** `tempIds`: each added task's temp_id to its real id, for a second
   *  batch that names the new rows (a paste's links and resources).
   *  `undoStep`: the undo step the batch went into (null: nothing to undo),
   *  for a later batch to join (ApplyOptions.joinUndo). */
  | { ok: true; notices: Notice[]; tempIds: Record<string, string>; undoStep?: number | null }
  | { ok: false; kind: 'confirm'; willComplete: CompletionBlocker[]; openPredecessors: CompletionBlocker[] }
  | { ok: false; kind: 'blocked'; blockers: CompletionBlocker[] }
  | { ok: false; kind: 'error'; message: string; code: string; taskIds?: string[] };

/** A failed write as an ApplyResult. A 409 `plan_changed` reads as a plain
 *  error here; the hook reloads before it answers one. */
export function failureOf(err: unknown): ApplyResult {
  const detail = planErrorDetail(err);
  if (detail?.code === 'completion_confirm') {
    return {
      ok: false, kind: 'confirm',
      willComplete: detail.will_complete ?? [], openPredecessors: detail.open_predecessors ?? [],
    };
  }
  if (detail?.code === 'completion_blocked') {
    return { ok: false, kind: 'blocked', blockers: detail.blockers ?? [] };
  }
  // an ApiError, DurationError and PredecessorError each carry a code
  const code = detail?.code ?? (err as { code?: unknown } | null)?.code;
  const taskIds = detail?.task_ids ?? (detail?.task_id ? [detail.task_id] : undefined);
  return {
    ok: false, kind: 'error', message: planErrorText(err),
    code: typeof code === 'string' ? code : 'unknown_error',
    ...(taskIds ? { taskIds } : {}),
  };
}

/**
 * The batch resent after a `completion_confirm`: `confirm: true` on every
 * op that completes something (set_percent, complete, mark_on_track, an
 * update_task that sets % complete). The other ops go as they were, a
 * signed restore above all, and the caller's ops are not changed.
 */
export function withConfirm(ops: readonly Op[]): Op[] {
  return ops.map((op) => {
    switch (op.op) {
      case 'set_percent':
      case 'complete':
      case 'mark_on_track':
        return { ...op, confirm: true };
      case 'update_task':
        return op.fields.percent_complete === undefined ? op : { ...op, confirm: true };
      default:
        return op;
    }
  });
}
