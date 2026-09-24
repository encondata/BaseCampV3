/**
 * BulkInitiativePeople — /bulk/initiative-people: pick a job, then upload
 * worker / site / role rows. The shared page shell, a job picker, and the
 * TeamBulkUpload pane (per-line matching of unknown values).
 */
import { useEffect, useMemo, useState } from 'react';

import BulkToolPage from '../components/bulk/BulkToolPage';
import ComboBox, { type ComboOption } from '../components/ComboBox';
import TeamBulkUpload from '../components/initiatives/TeamBulkUpload';
import {
  downloadTeamExport, downloadTeamTemplate, listInitiatives, type InitiativeItem,
} from '../lib/api';
import { jobOptionDetail, jobOptionLabel, TEAM_COLUMN_GUIDE } from '../lib/teamBulk';

export default function BulkInitiativePeople() {
  const [jobs, setJobs] = useState<InitiativeItem[] | null>(null);
  const [jobId, setJobId] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    listInitiatives()
      .then((all) => setJobs(all.filter((j) => !j.archived_at)))
      .catch(() => setLoadError('Could not load jobs — refresh to try again.'));
  }, []);

  const options: ComboOption[] = useMemo(() => (jobs ?? []).map((j) => ({
    value: j.id, label: jobOptionLabel(j), sub: jobOptionDetail(j),
  })), [jobs]);

  const needJob = async (fn: (id: string) => Promise<void>) => { if (jobId) await fn(jobId); };
  const noJob = !jobId;

  return (
    <BulkToolPage
      title="Assign people to a job"
      hint={<>
        Pick the job, then download the template or its current team, fill in who worked, where, and in what role, and upload it.
        New names are added; people already on the job are updated only where you tick Update. Nobody is removed.
        Names the system cannot match can be picked from a list in the preview.
      </>}
      guide={TEAM_COLUMN_GUIDE}
      downloads={[
        { key: 't-xlsx', label: 'Template (.xlsx)', run: () => needJob((id) => downloadTeamTemplate(id, 'xlsx')), disabled: noJob },
        { key: 't-csv', label: 'Template (.csv)', run: () => needJob((id) => downloadTeamTemplate(id, 'csv')), disabled: noJob },
        { key: 'e-xlsx', label: 'Current team (.xlsx)', run: () => needJob((id) => downloadTeamExport(id, 'xlsx')), accent: true, disabled: noJob },
        { key: 'e-csv', label: 'Current team (.csv)', run: () => needJob((id) => downloadTeamExport(id, 'csv')), accent: true, disabled: noJob },
      ]}
      beforeDownloads={
        <div className="bulk-job-picker">
          <label htmlFor="bulk-job">Job</label>
          <ComboBox inputId="bulk-job" ariaLabel="Job" options={options} value={jobId}
                    placeholder="Pick a job…" onChange={setJobId} />
          {loadError && <p className="pf-error">{loadError}</p>}
        </div>
      }
    >
      {jobId ? <TeamBulkUpload key={jobId} jobId={jobId} /> : <p className="set-note">Pick a job to upload a team.</p>}
    </BulkToolPage>
  );
}
