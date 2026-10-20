/** Clock Out: today so far (the big total and the day's punches), then
 *  Confirm Clock Out. In landscape the total sits left of the table. */

import type { KioskTimeclockStatus } from '../../lib/api';
import { formatClock, formatWorked } from '../format';
import { IconArrowRight, IconClockIn, IconClockOut } from '../icons';
import PunchError from './PunchError';

export interface ClockOutSummaryProps {
  status: KioskTimeclockStatus;
  busy: boolean;
  error: string | null;
  onConfirm(): void;
  onRetry(): void;
}

export default function ClockOutSummary({ status, busy, error, onConfirm, onRetry }: ClockOutSummaryProps) {
  const worked = formatWorked(status.today_minutes);
  return (
    <section className="tcx-screen tcx-clockout">
      <div className="tcx-clockout-total">
        <h1 className="tcx-title tcx-title-icon"><IconClockOut className="tcx-heading-icon" />Clock Out</h1>
        <p className="tcx-lead">You&apos;ve been working for</p>
        <p className="tcx-big">{worked}</p>
        <p className="tcx-lead">today</p>
      </div>
      <div className="tcx-clockout-side">
        <table className="tcx-punches">
          <tbody>
            {status.today_entries.flatMap((entry, i) => [
              <tr key={`in-${i}`}>
                <th scope="row"><IconClockIn className="tcx-row-icon" />Clock In</th>
                <td>{formatClock(entry.clock_in_at)}</td>
              </tr>,
              <tr key={`out-${i}`}>
                <th scope="row"><IconClockOut className="tcx-row-icon" />Clock Out</th>
                <td>{entry.clock_out_at ? formatClock(entry.clock_out_at) : 'now'}</td>
              </tr>,
            ])}
            <tr className="is-total">
              <th scope="row">Total</th>
              <td>{worked}</td>
            </tr>
          </tbody>
        </table>
        {error && <PunchError error={error} busy={busy} onRetry={onRetry} />}
        <button type="button" className="tcx-btn is-primary" disabled={busy} onClick={onConfirm}>
          Confirm Clock Out <IconArrowRight className="tcx-btn-icon" />
        </button>
      </div>
    </section>
  );
}
