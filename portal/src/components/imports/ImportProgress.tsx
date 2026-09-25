/** A running move-assets import: the progress bar, "N of M rows", and the
 *  rows/s line with its estimate once there is a speed to show. */
import type { ImportJobOut } from '../../lib/api';
import { jobProgressPct } from '../../lib/moveAssetImport';

interface Props { job: ImportJobOut; speed: number; eta: number | null }

export default function ImportProgress({ job, speed, eta }: Props) {
  return (
    <>
      <div className="idet-assets-progress">
        <div className="idet-assets-progress-label">
          <span>{jobProgressPct(job)}%</span>
        </div>
        <div className="idet-assets-progress-track">
          <div className="idet-assets-progress-fill"
               style={{ width: `${jobProgressPct(job)}%` }} />
        </div>
      </div>

      <p className="page-hint imp-progress-hint">
        {job.processed_rows} of {job.total_rows} rows
      </p>
      {speed > 0 && (
        <p className="page-hint imp-progress-meta">
          ~{Math.round(speed)} rows/s
          {eta !== null && eta > 0 ? ` · about ${eta}s left` : ''}
        </p>
      )}
    </>
  );
}
