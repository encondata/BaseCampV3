/**
 * What happens when a write that completes a task is stopped by the plan's
 * completion rules (ApplyResult `confirm` or `blocked`): the one place the
 * sheet, the toolbar's 0–100% and Mark on Track, the chart's drags and a
 * paste call, so Task 10 can swap the CompletionDialog in here without
 * touching them (Ruling B2).
 *
 * Until then it is a toast. `blocked` names the tasks in the way; `confirm`
 * names what completes along with it (or the open predecessors the plan
 * warns about) and offers "Complete anyway", which calls `resend`: the
 * caller's own write again with `confirm: true` (usePlan's `confirm`), so
 * a two-batch command resends both of its batches and a paste's last batch
 * joins the paste's undo step. What the resend answers is said like any
 * other write.
 *
 * `sayNotices` and `useApplyAnswer` are how every write's answer is said:
 * a notice (a constraint an edit added or cleared) as a toast with Undo,
 * a stopped completion to the prompt, a refusal as a toast — the sheet,
 * the toolbar and the chart's drags all say it the same way.
 */
import { useCallback, useLayoutEffect, useRef } from 'react';

import { useToast, type ToastAction } from '../../lib/notificationsContext';
import type { Notice, Op } from '../../lib/plans/api';
import type { ApplyResult } from '../../lib/plans/applyResult';
import { noticeText } from '../../lib/plans/editOps';
import { completionText } from '../../lib/plans/errors';
import type { PlanController } from './usePlan';

export type CompletionStop = Extract<ApplyResult, { kind: 'confirm' | 'blocked' }>;

/** The stopped write sent again with `confirm: true`. */
export type Resend = () => Promise<ApplyResult>;

export interface PromptOptions {
  /** What already went in, said first ("Rows were added. "). */
  lead?: string;
}

export type CompletionPrompt = (stop: CompletionStop, resend: Resend, opts?: PromptOptions) => void;

/** Errors usePlan has already told the person about (or that mean the tab
 *  moved on): no second toast. */
export const SAID_ALREADY: ReadonlySet<string> = new Set(['plan_changed', 'gone']);

type Toast = (message: string, action?: ToastAction) => void;

/** A batch's notices, each a toast with Undo (which takes the batch back). */
export function sayNotices(toast: Toast, notices: readonly Notice[], undo: () => void): void {
  for (const notice of notices) toast(noticeText(notice), { label: 'Undo', onClick: undo });
}

export function useCompletionPrompt(ctl: PlanController): CompletionPrompt {
  const toast = useToast();
  const ctlRef = useRef(ctl);
  useLayoutEffect(() => {
    ctlRef.current = ctl;
  }, [ctl]);

  return useCallback((stop: CompletionStop, resend: Resend, opts: PromptOptions = {}) => {
    const lead = opts.lead ?? '';
    if (stop.kind === 'blocked') {
      toast(`${lead}${completionText(stop)}`);
      return;
    }
    toast(`${lead}${completionText(stop)}`, {
      label: 'Complete anyway',
      onClick: () => {
        void resend().then((again) => {
          if (again.ok) {
            sayNotices(toast, again.notices, () => void ctlRef.current.undo());
          } else if (again.kind === 'error') {
            if (!SAID_ALREADY.has(again.code) && again.message) toast(again.message);
          } else {
            toast(completionText(again));
          }
        });
      },
    });
  }, [toast]);
}

/** Says one write's answer: notices with Undo, a stopped completion to the
 *  prompt (Complete resends `ops` with confirm), a refusal as a toast
 *  (unless usePlan said it already). True when the batch went through. */
export type ApplyAnswer = (result: ApplyResult, ops: Op[], label: string) => boolean;

export function useApplyAnswer(ctl: PlanController): ApplyAnswer {
  const toast = useToast();
  const prompt = useCompletionPrompt(ctl);
  const latest = useRef({ ctl, toast, prompt });
  useLayoutEffect(() => {
    latest.current = { ctl, toast, prompt };
  });

  return useCallback((result: ApplyResult, ops: Op[], label: string): boolean => {
    const { toast: say, prompt: ask } = latest.current;
    if (result.ok) {
      sayNotices(say, result.notices, () => void latest.current.ctl.undo());
      return true;
    }
    if (result.kind !== 'error') {
      ask(result, () => latest.current.ctl.apply(ops, label, { confirm: true }));
      return false;
    }
    if (!SAID_ALREADY.has(result.code) && result.message) say(result.message);
    return false;
  }, []);
}
