/** What would you like to do? Clock In and Clock Out; only the one that
 *  fits the person's status can be tapped, the other is dimmed. Clock In
 *  punches straight away. In landscape the tiles sit in one row. */

import type { KioskTimeclockStatus } from '../../lib/api';
import { IconClockIn, IconClockOut } from '../icons';
import PunchError from './PunchError';

const TITLE = 'What would you like to do?';

export interface ChooseActionProps {
  status: KioskTimeclockStatus;
  /** A punch (or a status re-read) is in flight. */
  busy: boolean;
  notice: string | null;
  error: string | null;
  onIn(): void;
  onOut(): void;
  onRetry(): void;
}

export default function ChooseAction({
  status, busy, notice, error, onIn, onOut, onRetry,
}: ChooseActionProps) {
  return (
    <section className="tcx-screen tcx-action">
      <h1 className="tcx-title">{TITLE}</h1>
      {notice && <p className="tcx-notice" role="status">{notice}</p>}
      {error && <PunchError error={error} busy={busy} onRetry={onRetry} />}
      <div className="tcx-tiles" role="group" aria-label={TITLE}>
        <button
          type="button" className="tcx-tile is-in" disabled={busy || status.clocked_in} onClick={onIn}
        >
          <IconClockIn className="tcx-tile-icon" />
          <span className="tcx-tile-title">Clock In</span>
          <span className="tcx-tile-sub">Start your work day</span>
        </button>
        <button
          type="button" className="tcx-tile is-out" disabled={busy || !status.clocked_in} onClick={onOut}
        >
          <IconClockOut className="tcx-tile-icon" />
          <span className="tcx-tile-title">Clock Out</span>
          <span className="tcx-tile-sub">End your work day</span>
        </button>
      </div>
    </section>
  );
}
