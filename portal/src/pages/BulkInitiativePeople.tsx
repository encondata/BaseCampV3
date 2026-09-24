/**
 * BulkInitiativePeople — /bulk/initiative-people: the shared page shell
 * configured for a job's team, with a job picker under the hint and
 * TeamBulkUpload as the upload pane (disabled until a job is picked;
 * per-line matching of unknown values).
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
      title="Add or update a job's team in bulk"
      hint={<>
        Download the template or the job's current team, fill it in, upload it, and review every add before applying.
        Rows match people on the job by worker name; matched rows are skipped unless you check Update.
        Sites and roles are matched by name and must already exist. Names that do not match can be picked in the preview.
        Nobody is removed.
      </>}
      intro={
        <div className="bulk-file-row">
          <label htmlFor="bulk-job">Job</label>
          <ComboBox inputId="bulk-job" ariaLabel="Job" options={options} value={jobId}
                    placeholder="Pick a job…" onChange={setJobId} />
          {loadError && <p className="pf-error">{loadError}</p>}
        </div>
      }
      guide={TEAM_COLUMN_GUIDE}
      downloads={[
        { key: 't-xlsx', label: 'Template (.xlsx)', run: () => needJob((id) => downloadTeamTemplate(id, 'xlsx')), disabled: noJob },
        { key: 't-csv', label: 'Template (.csv)', run: () => needJob((id) => downloadTeamTemplate(id, 'csv')), disabled: noJob },
        { key: 'e-xlsx', label: 'Current team (.xlsx)', run: () => needJob((id) => downloadTeamExport(id, 'xlsx')), accent: true, disabled: noJob },
        { key: 'e-csv', label: 'Current team (.csv)', run: () => needJob((id) => downloadTeamExport(id, 'csv')), accent: true, disabled: noJob },
      ]}
    >
      <TeamBulkUpload key={jobId} jobId={jobId || null} />
    </BulkToolPage>
  );
}
