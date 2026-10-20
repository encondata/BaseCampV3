/**
 * The yellow label regeneration takeover: on a laptop set up as a Label
 * Station, while the edge is generating labels (GET /edge/labels/status
 * says `running`), the whole screen turns yellow over every shell page
 * with what is happening and how far along it is. It can't be dismissed;
 * it goes away when the run ends.
 *
 * The title follows the run's reason: the first run after setup is
 * "Preparing labels for this move", a run for synced or printer changes
 * says updates were detected. The edge keeps the last run's reason while
 * idle, so only `state` decides whether the screen shows.
 *
 * Polled every second. Nothing here throws at the page: a failed poll
 * (signed out, offline, an older edge) keeps the last state. When polls
 * have kept failing for LABEL_RUN_UNREACHABLE_MS while the screen is up,
 * it says the label service can't be reached instead (still no dismiss),
 * keeps polling, and goes away once a poll answers idle.
 *
 * While open it is on the shared takeover stack (`lib/takeover`):
 * everything outside it is inert, and while it is on top it stops key
 * presses (a keyboard-wedge scan) from reaching the page underneath.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { getLabelRunStatus, type LabelRunStatus } from '../lib/api';
import { openTakeovers, syncInert } from '../lib/takeover';

/** How often the edge is asked about the label run. */
export const LABEL_RUN_POLL_MS = 1000;
/** How long polls fail in a row before the screen says so. */
export const LABEL_RUN_UNREACHABLE_MS = 10_000;

const TITLES: Record<'setup' | 'updates', string> = {
  setup: 'Preparing labels for this move',
  updates: 'Label regeneration in progress — updates were detected',
};

export default function LabelRegenScreen() {
  const titleId = useId();
  const progressId = useId();
  const [run, setRun] = useState<LabelRunStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failingSince: number | null = null;
    const poll = async () => {
      try {
        const next = await getLabelRunStatus();
        failingSince = null;
        if (!cancelled) {
          setRun(next);
          setUnreachable(false);
        }
      } catch {
        /* signed out, offline, or not a Label Station: keep the last state */
        const now = Date.now();
        failingSince ??= now;
        if (!cancelled && now - failingSince >= LABEL_RUN_UNREACHABLE_MS) setUnreachable(true);
      }
      if (!cancelled) timer = setTimeout(() => { void poll(); }, LABEL_RUN_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  const open = run?.state === 'running';

  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const root = rootRef.current;
    if (!root) return undefined;
    openTakeovers.push(root);
    syncInert();
    root.focus();
    // Not preventDefault: browser shortcuts keep working; the page just
    // never hears the key.
    const onKey = (e: KeyboardEvent) => {
      if (openTakeovers[openTakeovers.length - 1] !== root) return;
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const at = openTakeovers.indexOf(root);
      if (at >= 0) openTakeovers.splice(at, 1);
      syncInert();
    };
  }, [open]);

  if (!open || !run) return null;

  if (unreachable) {
    return (
      <div ref={rootRef} className="label-regen" role="alertdialog" aria-modal="true" tabIndex={-1}
           aria-labelledby={titleId} aria-describedby={progressId}>
        <div className="label-regen-card">
          <h1 id={titleId} className="label-regen-title">Can't reach this laptop's label service.</h1>
          <p id={progressId} className="label-regen-count">Labels may be out of date.</p>
        </div>
      </div>
    );
  }

  const title = TITLES[run.reason === 'setup' ? 'setup' : 'updates'];
  const total = Math.max(0, run.total);
  const done = Math.min(Math.max(0, run.done), total);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div ref={rootRef} className="label-regen" role="alertdialog" aria-modal="true" tabIndex={-1}
         aria-labelledby={titleId} aria-describedby={progressId}>
      <div className="label-regen-card">
        <h1 id={titleId} className="label-regen-title">{title}</h1>
        <p id={progressId} className="label-regen-count">{done} of {total}</p>
        <div className="label-regen-bar" role="progressbar" aria-labelledby={titleId}
             {...(total > 0 ? { 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done } : {})}>
          <span style={{ width: `${percent}%` }} />
        </div>
      </div>
    </div>
  );
}
