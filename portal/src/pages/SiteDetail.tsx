/**
 * SiteDetail — full read view of a single site: overview, map, clients,
 * notes/files, and (Task 5) the curated + raw survey lists. Chrome mirrors
 * AssetDetail (idet- classes, init-panel); editable via the shared
 * SiteEditModal (same invocation Sites.tsx uses).
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import CollapsePanel from '../components/CollapsePanel';
import NotesFilesPanel from '../components/NotesFilesPanel';
import RawSurveyList from '../components/sites/RawSurveyList';
import SiteEditModal from '../components/sites/SiteEditModal';
import SiteSurveyList from '../components/sites/SiteSurveyList';
import SitesMap from '../components/sites/SitesMap';
import {
  getSite, listClients, listPartners, listSiteStatuses, listSiteTypes,
  type OrgRef, type SiteDetailOut, type SiteLookup,
} from '../lib/api';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/sites.css';
import '../styles/system.css';

import StatusHover from '../components/StatusHover';

const chip = (label: string | null, color: string | null) =>
  label && color ? (
    <span className="chip custom" style={{ '--chip': color } as CSSProperties}>
      <span className="dot" />{label}
    </span>
  ) : null;

export default function SiteDetail() {
  const { siteId } = useParams<{ siteId: string }>();
  const { can } = useAuth();
  const canChange = can('sites', 'change');

  const [site, setSite] = useState<SiteDetailOut | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [surveyCount, setSurveyCount] = useState<{ filled: number; total: number } | null>(null);
  const [rawSurveyCount, setRawSurveyCount] = useState<number | null>(null);
  const [surveyVersion, setSurveyVersion] = useState(0);

  const [types, setTypes] = useState<SiteLookup[]>([]);
  const [statuses, setStatuses] = useState<SiteLookup[]>([]);
  const [clients, setClients] = useState<OrgRef[]>([]);
  const [partners, setPartners] = useState<OrgRef[]>([]);

  const load = useCallback(async () => {
    if (!siteId) return;
    try {
      setSite(await getSite(siteId));
      setMissing(false);
    } catch {
      setMissing(true);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
    if (canChange) {
      void listSiteTypes().then(setTypes).catch(() => {});
      void listSiteStatuses().then(setStatuses).catch(() => {});
      void listClients().then(setClients).catch(() => {});
      void listPartners().then(setPartners).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const back = <Link to="/sites" className="idet-back">← Sites</Link>;

  if (missing) {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Site not found</b>This site does not exist or was removed.
        </div>
      </div>
    );
  }
  if (!site) {
    return <div className="portal-page">{back}<p className="page-hint">Loading…</p></div>;
  }

  return (
    <div className="portal-page">
      {back}
      <div className="idet-header">
        <div className="idet-heading">
          <div className="idet-title-row">
            <h1 className="page-title">{site.name}</h1>
            {chip(site.type_label, site.type_color)}
            <StatusHover entityType="site" entityId={site.id} status={site.status}>
              <span className="chip custom" style={{ '--chip': site.status_color } as CSSProperties}>
                <span className="dot" />{site.status_label}
              </span>
            </StatusHover>
            {site.archived_at && <span className="chip tag">Archived</span>}
          </div>
          <p className="page-hint">
            {[site.type_label, site.status_label].filter(Boolean).join(' · ') || '—'}
          </p>
        </div>
        {canChange && (
          <div className="idet-header-actions">
            <button className="btn-solid" onClick={() => setEditing(true)}>Edit</button>
          </div>
        )}
      </div>

      <div className="init-panel">
        <p className="eyebrow-sm">Overview</p>
        <dl className="kv">
          <dt>Code</dt><dd className="mono">{site.code ?? '—'}</dd>
          <dt>Address line 1</dt><dd>{site.address_line1 ?? '—'}</dd>
          <dt>Address line 2</dt><dd>{site.address_line2 ?? '—'}</dd>
          <dt>City</dt><dd>{site.city ?? '—'}</dd>
          <dt>Region</dt><dd>{site.region ?? '—'}</dd>
          <dt>Postal code</dt><dd>{site.postal_code ?? '—'}</dd>
          <dt>Country</dt><dd>{site.country ?? '—'}</dd>
          <dt>Timezone</dt><dd>{site.timezone ?? '—'}</dd>
          <dt>DC provider</dt><dd>{site.dc_provider ?? '—'}</dd>
          <dt>Supplying partner</dt><dd>{site.partner_name ?? '—'}</dd>
          <dt>Latitude</dt><dd className="mono">{site.latitude ?? '—'}</dd>
          <dt>Longitude</dt><dd className="mono">{site.longitude ?? '—'}</dd>
          <dt>Created</dt><dd>{new Date(site.created_at).toLocaleDateString()}</dd>
        </dl>
      </div>

      <div className="init-panel">
        <p className="eyebrow-sm">Map</p>
        {site.latitude != null
          ? <SitesMap sites={[site]} onSelect={() => {}} />
          : <p className="page-hint">No coordinates recorded.</p>}
      </div>

      <div className="init-panel">
        <p className="eyebrow-sm">Clients</p>
        <div className="chips">
          {site.clients.length === 0 && <span className="chip tag">No linked clients</span>}
          {site.clients.map((c) => <span key={c.client_id} className="chip c-blue">{c.name}</span>)}
        </div>
      </div>

      <div className="init-panel">
        <NotesFilesPanel entityType="site" entityId={site.id} canWrite={canChange} />
      </div>

      <div className="init-panel">
        <CollapsePanel title="Site Survey Data"
                       badge={surveyCount && (
                         <span className="badge-count">
                           {surveyCount.filled}/{surveyCount.total} filled
                         </span>
                       )}>
          <SiteSurveyList siteId={site.id} onCount={setSurveyCount}
                          onSaved={() => setSurveyVersion((v) => v + 1)}
                          refreshKey={surveyVersion} />
        </CollapsePanel>
      </div>

      <div className="init-panel">
        <CollapsePanel title="Raw Survey Data"
                       badge={rawSurveyCount !== null && (
                         <span className="badge-count">{rawSurveyCount} entries</span>
                       )}>
          <RawSurveyList siteId={site.id} refreshKey={surveyVersion} onCount={setRawSurveyCount} />
        </CollapsePanel>
      </div>

      {editing && (
        <SiteEditModal
          site={site}
          types={types}
          statuses={statuses}
          clients={clients}
          partners={partners}
          canChange={canChange}
          onClose={() => setEditing(false)}
          onSaved={() => { void load(); setSurveyVersion((v) => v + 1); }}
        />
      )}
    </div>
  );
}
