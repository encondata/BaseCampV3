/**
 * BulkAssignWorkers — /bulk/assign-workers: the shared page shell for
 * assigning a partner's workers to a job from a returned template, with
 * initiative, site and partner pickers under the hint and AssignBulkUpload
 * as the upload pane.
 */
import { useEffect, useMemo, useState } from 'react';

import BulkToolPage from '../components/bulk/BulkToolPage';
import ComboBox, { type ComboOption } from '../components/ComboBox';
import AssignBulkUpload from '../components/workers/AssignBulkUpload';
import {
  downloadAssignTemplate, listInitiatives, listPartners, listSites,
  type InitiativeItem, type OrgRef, type SiteItem,
} from '../lib/api';
import { ASSIGN_COLUMN_GUIDE } from '../lib/assignBulk';
import { jobOptionDetail, jobOptionLabel } from '../lib/teamBulk';

export default function BulkAssignWorkers() {
  const [jobs, setJobs] = useState<InitiativeItem[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [partners, setPartners] = useState<OrgRef[]>([]);
  const [jobId, setJobId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    Promise.all([listInitiatives(), listSites(), listPartners()])
      .then(([j, s, p]) => {
        setJobs(j.filter((x) => !x.archived_at));
        setSites(s.filter((x) => !x.archived_at));
        setPartners(p.filter((x) => !x.archived_at));
      })
      .catch(() => setLoadError('Could not load the pickers — refresh to try again.'));
  }, []);

  const jobOptions: ComboOption[] = useMemo(() => jobs.map((j) => ({
    value: j.id, label: jobOptionLabel(j), sub: jobOptionDetail(j),
  })), [jobs]);
  const siteOptions: ComboOption[] = useMemo(() => sites.map((s) => ({ value: s.id, label: s.name })), [sites]);
  const partnerOptions: ComboOption[] = useMemo(() => partners.map((p) => ({ value: p.id, label: p.name })), [partners]);

  return (
    <BulkToolPage
      title="Assign workers from a template"
      hint={<>
        Send the template to the partner, then upload the file they return. Pick the initiative, site and partner,
        review each worker's match and role, and import. Rows are matched to existing workers by name, then email,
        then phone. A row with no match can be matched by hand or created as a new worker. Nobody is removed.
      </>}
      introClassName="bulk-intro-3"
      intro={<>
        <div className="bulk-file-row">
          <label htmlFor="assign-initiative">Initiative</label>
          <ComboBox inputId="assign-initiative" ariaLabel="Initiative" options={jobOptions} value={jobId}
                    placeholder="Pick an initiative…" onChange={setJobId} />
        </div>
        <div className="bulk-file-row">
          <label htmlFor="assign-site">Site</label>
          <ComboBox inputId="assign-site" ariaLabel="Site" options={siteOptions} value={siteId}
                    placeholder="Pick a site…" onChange={setSiteId} />
        </div>
        <div className="bulk-file-row">
          <label htmlFor="assign-partner">Partner</label>
          <ComboBox inputId="assign-partner" ariaLabel="Partner" options={partnerOptions} value={partnerId}
                    placeholder="Pick a partner…" onChange={setPartnerId} />
        </div>
        {loadError && <p className="pf-error">{loadError}</p>}
      </>}
      guide={ASSIGN_COLUMN_GUIDE}
      downloads={[
        { key: 't-xlsx', label: 'Template (.xlsx)', run: downloadAssignTemplate },
      ]}
    >
      <AssignBulkUpload key={`${jobId}|${siteId}|${partnerId}`} jobId={jobId} siteId={siteId} partnerId={partnerId} />
    </BulkToolPage>
  );
}
