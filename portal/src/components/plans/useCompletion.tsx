/**
 * What happens when a write that completes a task is stopped by the plan's
 * completion rules (ApplyResult `confirm` or `blocked`): the one place
 * every 100% path goes (Ruling B2) — the sheet's % Complete, the toolbar's
 * 0–100% and Mark on Track, the chart's progress drag, a paste, Task
 * Information and Update project.
 *
 * PlanTab owns one `useCompletion(ctl)`, renders its `dialog` (the
 * CompletionDialog) and hands it down through `CompletionContext`; the
 * sheet and the chart read it with `useCompletionPrompt` / `useApplyAnswer`.
 *
 * - `confirm` names what completes along with it (the open subtasks) and
 *   the open predecessors the plan warns about; Complete calls `resend`:
 *   the caller's own write again with `confirm: true` (usePlan's
 *   `confirm`), so a two-batch command resends both of its batches and a
 *   paste's last batch joins the paste's undo step. Another stop in the
 *   answer takes the dialog's place.
 * - `blocked` names the tasks in the way, each with Go to task (`onGoTo`
 *   selects it and scrolls it into view in the sheet and the chart).
 * - The dialog stays until it is answered (no timeout). Each stop holds
 *   editing from the moment `ask` takes it (in the same tick, so a hold
 *   let go right after — the cell editor's — overlaps it) until it is
 *   answered, so a refresh that finds someone else's change waits. Stops
 *   that arrive meanwhile wait their turn behind it, holding too.
 *
 * `ask` answers once the dialog closes: the resend's answer when Complete
 * went through or failed, null when it closed unanswered (Cancel, Close,
 * Go to task). `prompt` is `ask` for callers that move on at once: it says
 * the resend's answer itself (notices with Undo, a refusal as a toast).
 * `answer` says one write's whole answer that way; `run` sends a batch and
 * answers it.
 */
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';

import { useToast, type ToastAction } from '../../lib/notificationsContext';
import type { Notice, Op } from '../../lib/plans/api';
import type { ApplyResult } from '../../lib/plans/applyResult';
import { noticeText } from '../../lib/plans/editOps';
import { planErrorText } from '../../lib/plans/errors';
import CompletionDialog from './CompletionDialog';
import type { PlanController } from './usePlan';

export type CompletionStop = Extract<ApplyResult, { kind: 'confirm' | 'blocked' }>;

/** The stopped write sent again with `confirm: true`. */
export type Resend = () => Promise<ApplyResult>;

export interface PromptOptions {
  /** What already went in, said first ("Rows were added. "). */
  lead?: string;
}

/** Opens the dialog; answers once it closes (see the header). */
export type CompletionAsk = (stop: CompletionStop, resend: Resend, opts?: PromptOptions) => Promise<ApplyResult | null>;

/** `ask` for a caller that moves on at once: the resend's answer is said here. */
export type CompletionPrompt = (stop: CompletionStop, resend: Resend, opts?: PromptOptions) => void;

/** Says one write's answer: notices with Undo, a stopped completion to the
 *  dialog (Complete resends `ops` with confirm), a refusal as a toast
 *  (unless usePlan said it already). True when the batch went through. */
export type ApplyAnswer = (result: ApplyResult, ops: Op[], label: string) => boolean;

export interface Completion {
  /** Sends `ops` and says the answer (`answer`). */
  run(ops: Op[], label: string): Promise<void>;
  ask: CompletionAsk;
  prompt: CompletionPrompt;
  answer: ApplyAnswer;
  /** The dialog, while a stop waits for its answer. */
  dialog: ReactNode;
}

/** Errors usePlan has already told the person about (or that mean the tab
 *  moved on): no second toast. */
export const SAID_ALREADY: ReadonlySet<string> = new Set(['plan_changed', 'gone']);

const HOLD_OWNER = 'completion-check';

type Toast = (message: string, action?: ToastAction) => void;

/** A batch's notices, each a toast with Undo (which takes the batch back). */
export function sayNotices(toast: Toast, notices: readonly Notice[], undo: () => void): void {
  for (const notice of notices) toast(noticeText(notice), { label: 'Undo', onClick: undo });
}

interface Waiting {
  id: number;
  stop: CompletionStop;
  resend: Resend;
  lead?: string;
  resolve(result: ApplyResult | null): void;
  /** Lets go of its editing hold. */
  release(): void;
}

export function useCompletion(ctl: PlanController, opts: { onGoTo?(taskId: string): void } = {}): Completion {
  const toast = useToast();
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const latest = useRef({ ctl, toast, onGoTo: opts.onGoTo, waiting });
  useLayoutEffect(() => {
    latest.current = { ctl, toast, onGoTo: opts.onGoTo, waiting };
  });

  // what waits now, as `ask` and `finish` change it (state lags a render)
  const queued = useRef<Waiting[]>([]);

  // the tab going away answers whatever still waits, and lets go of its holds
  useEffect(() => () => {
    for (const w of queued.current) {
      w.release();
      w.resolve(null);
    }
    queued.current = [];
  }, []);

  // the hold is taken here, at once: a caller that lets go of its own hold
  // right after (the cell editor) never leaves a gap for a refresh
  const ask = useCallback<CompletionAsk>((stop, resend, o = {}) => new Promise((resolve) => {
    seq.current += 1;
    const id = seq.current;
    const release = latest.current.ctl.beginEditing(HOLD_OWNER);
    const w: Waiting = { id, stop, resend, lead: o.lead, resolve, release };
    queued.current = [...queued.current, w];
    setWaiting((list) => [...list, w]);
  }), []);

  /** What a resend (or any write) answered, said: notices, a refusal. */
  const say = useCallback((result: ApplyResult | null) => {
    if (!result) return;
    const { toast: show } = latest.current;
    if (result.ok) {
      sayNotices(show, result.notices, () => void latest.current.ctl.undo());
    } else if (result.kind === 'error' && !SAID_ALREADY.has(result.code) && result.message) {
      show(result.message);
    }
  }, []);

  const prompt = useCallback<CompletionPrompt>((stop, resend, o) => {
    void ask(stop, resend, o).then(say);
  }, [ask, say]);

  const answer = useCallback<ApplyAnswer>((result, ops, label) => {
    if (result.ok) {
      say(result);
      return true;
    }
    if (result.kind !== 'error') {
      prompt(result, () => latest.current.ctl.apply(ops, label, { confirm: true }));
      return false;
    }
    say(result);
    return false;
  }, [prompt, say]);

  const run = useCallback(async (ops: Op[], label: string) => {
    answer(await latest.current.ctl.apply(ops, label), ops, label);
  }, [answer]);

  const current = waiting[0] ?? null;

  const finish = useCallback((w: Waiting, result: ApplyResult | null) => {
    queued.current = queued.current.filter((x) => x.id !== w.id);
    setWaiting((list) => list.filter((x) => x.id !== w.id));
    setBusy(false);
    w.release();
    w.resolve(result);
  }, []);

  const dialog = useMemo(() => {
    if (!current) return null;
    const confirm = async () => {
      setBusy(true);
      // a resend that throws is said, and leaves the dialog usable (Complete
      // or Cancel), never stuck busy
      try {
        const again = await current.resend();
        if (!again.ok && again.kind !== 'error') {
          // stopped again (the plan changed meanwhile): this stop takes its place
          setWaiting((list) => list.map((x) => (x.id === current.id ? { ...x, stop: again } : x)));
          return;
        }
        finish(current, again);
      } catch (err) {
        latest.current.toast(planErrorText(err));
      } finally {
        setBusy(false);
      }
    };
    return (
      <CompletionDialog key={current.id} result={current.stop} lead={current.lead} busy={busy}
                        onConfirm={() => void confirm()}
                        onClose={() => finish(current, null)}
                        onGoTo={(taskId) => {
                          finish(current, null);
                          // once the dialog has gone and handed focus back
                          window.setTimeout(() => latest.current.onGoTo?.(taskId), 0);
                        }} />
    );
  }, [current, busy, finish]);

  return useMemo(() => ({ run, ask, prompt, answer, dialog }), [run, ask, prompt, answer, dialog]);
}

/** The tab's completion check, for the sheet and the chart under it. */
export const CompletionContext = createContext<Completion | null>(null);

function outsideItsHost(): never {
  throw new Error('a completion check needs PlanTab (or CompletionHost) above it');
}

const NO_HOST: Pick<Completion, 'ask' | 'prompt'> = {
  ask: () => outsideItsHost(),
  prompt: () => outsideItsHost(),
};

/** The fire-and-forget prompt of the tab's completion check. */
export function useCompletionPrompt(): CompletionPrompt {
  return (useContext(CompletionContext) ?? NO_HOST).prompt;
}

/** The tab's `ask`, for a dialog that waits on the answer (Task Information, Update project). */
export function useCompletionAsk(): CompletionAsk {
  return (useContext(CompletionContext) ?? NO_HOST).ask;
}

/** `answer` for a part of the tab (the chart's drags): the tab's own. */
export function useApplyAnswer(): ApplyAnswer {
  const host = useContext(CompletionContext);
  return host?.answer ?? outsideAnswer;
}

const outsideAnswer: ApplyAnswer = () => outsideItsHost();

/** A completion check of its own for a part rendered alone (a test, a
 *  story): `useCompletion` with its dialog, provided to `children`. */
export function CompletionHost({ ctl, onGoTo, children }: {
  ctl: PlanController;
  onGoTo?(taskId: string): void;
  children: ReactNode;
}) {
  const completion = useCompletion(ctl, { onGoTo });
  return (
    <CompletionContext.Provider value={completion}>
      {children}
      {completion.dialog}
    </CompletionContext.Provider>
  );
}
