/**
 * What happens when a write that completes a task is stopped by the plan's
 * completion rules (ApplyResult `confirm` or `blocked`): the one place the
 * sheet calls, so Task 10 can swap the CompletionDialog in here without
 * touching the sheet.
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
import type { PlanController } from './usePlan';

export type CompletionStop = Extract<ApplyResult, { kind: 'confirm' | 'blocked' }>;

/** Errors usePlan has already told the person about (or that mean the tab
 *  moved on): no second toast. */
const SAID_ALREADY = new Set(['plan_changed', 'gone']);

export function useCompletionPrompt(ctl: PlanController): (stop: CompletionStop, ops: Op[], label: string) => void {
  const toast = useToast();
  const ctlRef = useRef(ctl);
  useLayoutEffect(() => {
    ctlRef.current = ctl;
  }, [ctl]);

  return useCallback((stop: CompletionStop, ops: Op[], label: string) => {
    if (stop.kind === 'blocked') {
      toast(completionText(stop));
      return;
    }
    toast(completionText(stop), {
      label: 'Complete anyway',
      onClick: () => {
        void ctlRef.current.apply(ops, label, { confirm: true }).then((again) => {
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
