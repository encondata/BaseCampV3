/**
 * What happens when a write that completes a task is stopped by the plan's
 * completion rules (ApplyResult `confirm` or `blocked`): the one place the
 * sheet, the toolbar's 0–100% and Mark on Track, and a paste call, so
 * Task 10 can swap the CompletionDialog in here without touching them
 * (Ruling B2). `opts` go with the resend (a paste's second batch joins
 * its undo step).
 *
 * Until then it is a toast. `blocked` names the tasks in the way; `confirm`
 * names what completes along with it (or the open predecessors the plan
 * warns about) and offers "Complete anyway", which sends the same batch
 * again with `confirm: true` on each completing op (usePlan's `confirm`).
 */
import { useCallback, useLayoutEffect, useRef } from 'react';

import { useToast } from '../../lib/notificationsContext';
import type { Op } from '../../lib/plans/api';
import type { ApplyResult } from '../../lib/plans/applyResult';
import { completionText } from '../../lib/plans/errors';
import type { ApplyOptions, PlanController } from './usePlan';

export type CompletionStop = Extract<ApplyResult, { kind: 'confirm' | 'blocked' }>;

/** `opts` go with the resend (`joinUndo`: a paste's last batch joins the
 *  paste's own undo step); `frame` words the toast in context ("Rows were
 *  added. …"). */
export type CompletionPrompt = (stop: CompletionStop, ops: Op[], label: string, opts?: ApplyOptions,
  frame?: (text: string) => string) => void;

/** Errors usePlan has already told the person about (or that mean the tab
 *  moved on): no second toast. */
export const SAID_ALREADY: ReadonlySet<string> = new Set(['plan_changed', 'gone']);

export function useCompletionPrompt(ctl: PlanController): CompletionPrompt {
  const toast = useToast();
  const ctlRef = useRef(ctl);
  useLayoutEffect(() => {
    ctlRef.current = ctl;
  }, [ctl]);

  return useCallback((stop: CompletionStop, ops: Op[], label: string, opts: ApplyOptions = {},
    frame: (text: string) => string = (text) => text) => {
    if (stop.kind === 'blocked') {
      toast(frame(completionText(stop)));
      return;
    }
    toast(frame(completionText(stop)), {
      label: 'Complete anyway',
      onClick: () => {
        void ctlRef.current.apply(ops, label, { ...opts, confirm: true }).then((again) => {
          if (again.ok) return;
          if (again.kind === 'error') {
            if (!SAID_ALREADY.has(again.code) && again.message) toast(again.message);
          } else {
            toast(completionText(again));
          }
        });
      },
    });
  }, [toast]);
}
