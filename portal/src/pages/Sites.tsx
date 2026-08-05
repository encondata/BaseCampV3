/**
 * Sites — facilities we and our clients operate in. Directory pattern with
 * type/status chips, linked-client chips, and a read-only detail panel
 * (address, coordinates, partner, clients, notes, survey summary). All
 * mutation (create/edit/archive/clients/survey) lands in the Edit and
 * New-site modals — Task 3, not this file. The Edit/New-site buttons here
 * are wired to placeholder state so Task 3 only has to add the modals.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { useAuth } from '../auth/AuthContext';
import SiteEditModal from '../components/sites/SiteEditModal';
import SitesMap from '../components/sites/SitesMap';
import {
  ApiError,
  getSite,
  getSurveySchema,
  listClients,
  listPartners,
  listSiteStatuses,
  listSiteTypes,
  listSites,
  type OrgRef,
  type SiteItem,
  type SiteLookup,
  type SurveySchema,
} from '../lib/api';
import { initialOpenId } from '../lib/auditFormat';
import { useRecordFocus } from '../lib/useDeepLinkFilter';
import {
  formatCoords, matchesSiteFilters, naturalCompare, siteSearchText, type SiteFilters,
} from '../lib/sites';
import {
  ColumnsButton,
  ExportButton,
  FilterButton,
  exportCsv,
  type ColumnDef,
  type FacetGroup,
  type FacetState,
} from '../lib/listTools';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';
import '../styles/sites.css';

const COLUMNS: ColumnDef[] = [
  { key: 'type', label: 'Type', width: '1.1fr', default: true },
  { key: 'status', label: 'Status', width: '1.1fr', default: true },
  { key: 'clients', label: 'Clients', width: '1.7fr', default: true },
  { key: 'city', label: 'City', width: '1.1fr', default: true },
  { key: 'country', label: 'Country', width: '0.8fr', default: false },
  { key: 'dc_provider', label: 'DC provider', width: '1.2fr', default: false },
  { key: 'coords', label: 'Coords', width: '1.4fr', default: false },
];

type SortKey = 'name' | 'type' | 'status' | 'clients' | 'city' | 'country' | 'dc_provider' | 'coords';

const CSV_COLUMNS: [string, (s: SiteItem) => string][] = [
  ['ID', (s) => s.id],
  ['Name', (s) => s.name],
  ['Code', (s) => s.code ?? ''],
  ['Type', (s) => s.type_label ?? ''],
  ['Status', (s) => s.status_label],
  ['Address line 1', (s) => s.address_line1 ?? ''],
  ['Address line 2', (s) => s.address_line2 ?? ''],
  ['City', (s) => s.city ?? ''],
  ['Region', (s) => s.region ?? ''],
  ['Postal code', (s) => s.postal_code ?? ''],
  ['Country', (s) => s.country],
  ['Coordinates', (s) => formatCoords(s.latitude, s.longitude)],
  ['Timezone', (s) => s.timezone ?? ''],
  ['DC provider', (s) => s.dc_provider ?? ''],
  ['Partner', (s) => s.partner_name ?? ''],
  ['Clients', (s) => s.clients.map((c) => c.name).join('; ')],
  ['Notes', (s) => s.notes ?? ''],
  ['Archived', (s) => String(Boolean(s.archived_at))],
];

function surveySummary(
  data: Record<string, unknown> | null, schema: SurveySchema | null,
): string {
  if (!data || !schema) return 'No survey data';
  const keys = Object.keys(data);
  if (keys.length === 0) return 'No survey data';
  const answered = new Set(keys);
  const groupsHit = schema.groups.filter((g) => g.fields.some((f) => answered.has(f.key)));
  return `Survey: ${keys.length} field${keys.length === 1 ? '' : 's'} across `
    + `${groupsHit.length} group${groupsHit.length === 1 ? '' : 's'}`;
}

export default function Sites() {
  const { can, maxRank } = useAuth();
  const canAdd = can('sites', 'add');
  const canChange = can('sites', 'change');
  const canBulk = canAdd && maxRank >= 60;   // mirrors the API's GATE_BYPASS_RANK bar

  const [sites, setSites] = useState<SiteItem[] | null>(null);
  const [types, setTypes] = useState<SiteLookup[]>([]);
  const [statuses, setStatuses] = useState<SiteLookup[]>([]);
  const [clients, setClients] = useState<OrgRef[]>([]);
  const [partners, setPartners] = useState<OrgRef[]>([]);
  const [schema, setSchema] = useState<SurveySchema | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'list' | 'map'>('list');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  useRecordFocus(sites, (s) => s.id, (s) => s.name, setOpenId, setQuery);
  const [facets, setFacets] = useState<FacetState>({});
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    () => new Set(COLUMNS.filter((c) => c.default).map((c) => c.key)));

  // Edit/New-site modals land in Task 3 — these hold the row/create-mode
  // intent so that task only has to add the modal, not rewire the buttons.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      setSites(await listSites());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view sites.' : 'Failed to load sites.');
    }
  };

  useEffect(() => {
    void load();
    void listSiteTypes().then(setTypes).catch(() => {});
    void listSiteStatuses().then(setStatuses).catch(() => {});
    void listClients().then(setClients).catch(() => {});
    void listPartners().then(setPartners).catch(() => {});
    void getSurveySchema().then(setSchema).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filters: SiteFilters = useMemo(() => ({
    type: [...(facets.type ?? [])],
    status: [...(facets.status ?? [])],
    client: [...(facets.client ?? [])],
    country: [...(facets.country ?? [])],
    coords: [...(facets.coords ?? [])],
  }), [facets]);

  const facetGroups = useMemo<FacetGroup[]>(() => {
    const countries = new Set<string>();
    for (const s of sites ?? []) countries.add(s.country);
    return [
      { key: 'type', title: 'Type', options:
        types.map((t) => ({ value: t.key, label: t.label })) },
      { key: 'status', title: 'Status', options:
        statuses.map((s) => ({ value: s.key, label: s.label })) },
      { key: 'client', title: 'Client', options:
        clients.filter((c) => !c.archived_at).map((c) => ({ value: c.id, label: c.name })) },
      { key: 'country', title: 'Country', options:
        [...countries].sort().map((c) => ({ value: c, label: c })) },
      { key: 'coords', title: 'Coordinates', options: [
        { value: 'yes', label: 'Has coordinates' },
        { value: 'no', label: 'Missing coordinates' },
      ] },
    ];
  }, [sites, types, statuses, clients]);

  const visible = useMemo(() => {
    if (!sites) return [];
    const q = query.trim().toLowerCase();
    const rows = sites.filter((s) => {
      if (!matchesSiteFilters(s, filters)) return false;
      if (!q) return true;
      return siteSearchText(s).includes(q);
    });
    const val = (s: SiteItem): string => {
      switch (sortKey) {
        case 'name': return s.name.toLowerCase();
        case 'type': return (s.type_label ?? '').toLowerCase();
        case 'status': return s.status_label.toLowerCase();
        case 'clients': return s.clients.map((c) => c.name).join(',').toLowerCase();
        case 'city': return (s.city ?? '').toLowerCase();
        case 'country': return s.country.toLowerCase();
        case 'dc_provider': return (s.dc_provider ?? '').toLowerCase();
        case 'coords': return formatCoords(s.latitude, s.longitude);
      }
    };
    return rows.sort((a, b) => naturalCompare(val(a), val(b)) * sortDir);
  }, [sites, filters, query, sortKey, sortDir]);

  useEffect(() => {
    if (sites && openId && !visible.some((s) => s.id === openId)) setOpenId(null);
  }, [sites, visible, openId]);

  const noCoords = useMemo(
    () => visible.filter((s) => s.latitude === null || s.longitude === null),
    [visible],
  );

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(1); }
  };
  const caret = (key: SortKey) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const shownCols = COLUMNS.filter((c) => visibleCols.has(c.key));
  const grid = { gridTemplateColumns: `2.2fr ${shownCols.map((c) => c.width).join(' ')} 30px` };

  const cellFor = (s: SiteItem, key: string) => {
    switch (key) {
      case 'type':
        return s.type_color
          ? (
            <span className="chip custom" style={{ '--chip': s.type_color } as CSSProperties}>
              <span className="dot" />{s.type_label}
            </span>
          )
          : <span className="chip tag">{s.type_label ?? '—'}</span>;
      case 'status':
        return (
          <div className="chips">
            <span className="chip custom" style={{ '--chip': s.status_color } as CSSProperties}>
              <span className="dot" />{s.status_label}
            </span>
            {s.archived_at && <span className="chip tag">Archived</span>}
          </div>
        );
      case 'clients': {
        const shown = s.clients.slice(0, 2);
        const extra = s.clients.length - shown.length;
        return (
          <div className="chips">
            {s.clients.length === 0 && <span className="chip tag">—</span>}
            {shown.map((c) => <span key={c.client_id} className="chip c-blue">{c.name}</span>)}
            {extra > 0 && <span className="chip tag">+{extra}</span>}
          </div>
        );
      }
      case 'city':
        return <span className="cell-top">{s.city ?? '—'}</span>;
      case 'country':
        return <span className="cell-top">{s.country}</span>;
      case 'dc_provider':
        return <span className="cell-top">{s.dc_provider ?? '—'}</span>;
      case 'coords':
        return <span className="mono">{formatCoords(s.latitude, s.longitude)}</span>;
      default:
        return null;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Operations</div>
          <h1 className="page-title">
            Sites
            <span className="badge-count">{sites?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">
            Facilities we and our clients operate in — type, status, and location.
          </p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'on' : ''}
                  onClick={() => setView('list')}>
            List
          </button>
          <button role="tab" aria-selected={view === 'map'} className={view === 'map' ? 'on' : ''}
                  onClick={() => setView('map')}>
            Map
          </button>
        </div>
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {sites?.length ?? 0} shown</span>
          <FilterButton groups={facetGroups} state={facets} onChange={setFacets} />
          <ColumnsButton columns={COLUMNS} visible={visibleCols} onChange={setVisibleCols} />
          <ExportButton onExport={() => exportCsv('sites', CSV_COLUMNS, visible)} />
          {canAdd && (
            <button className="btn-solid" onClick={() => setCreating(true)}>
              + New site
            </button>
          )}
        </div>
      </div>

      {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>Cannot load sites</b>{error}</div>}

      {!error && view === 'list' && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            <button className="sortable" onClick={() => toggleSort('name')}>Name {caret('name')}</button>
            {shownCols.map((c) => (
              <button key={c.key} className="sortable"
                      onClick={() => toggleSort(c.key as SortKey)}>
                {c.label} {caret(c.key as SortKey)}
              </button>
            ))}
            <span />
          </div>

          {sites && visible.length === 0 && (
            <div className="dir-empty">
              <b>No matches</b>Try a different filter — or add a site.
            </div>
          )}

          {visible.map((s) => {
            const open = openId === s.id;
            return (
              <div key={s.id} className={`dir-row ${open ? 'open' : ''} ${s.archived_at ? 'archived' : ''}`}>
                <div className="row-main" style={grid}
                     onClick={() => setOpenId(open ? null : s.id)}>
                  <div className="cell cell-primary">
                    <div className="pn">
                      <b>{s.name}</b>
                      <span>{s.code ?? '—'}</span>
                    </div>
                  </div>
                  {shownCols.map((c) => (
                    <div className="cell" key={c.key}>{cellFor(s, c.key)}</div>
                  ))}
                  <div className="cell chevron-cell">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                         strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                  </div>
                </div>

                <div className="detail">
                  <div className="detail-clip">
                    <div className="detail-inner">
                      {open && (
                        <SiteRowDetail
                          site={s}
                          schema={schema}
                          canEdit={canChange}
                          onEdit={() => setEditingId(s.id)}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!error && view === 'map' && (
        <div className="sites-map-view">
          <SitesMap sites={visible} onSelect={(id) => { setView('list'); setOpenId(id); }} />
          {noCoords.length > 0 && (
            <p className="set-note">
              {noCoords.length} site{noCoords.length === 1 ? '' : 's'} without coordinates —{' '}
              {noCoords.map((s) => s.name).join(', ')}
            </p>
          )}
        </div>
      )}

      {editingId !== null && (
        <SiteEditModal
          site={sites?.find((s) => s.id === editingId) ?? null}
          types={types}
          statuses={statuses}
          clients={clients}
          partners={partners}
          canChange={canChange}
          onClose={() => setEditingId(null)}
          onSaved={() => load()}
        />
      )}
      {creating && (
        <SiteEditModal
          site={null}
          types={types}
          statuses={statuses}
          clients={clients}
          partners={partners}
          canChange={canChange}
          canBulk={canBulk}
          onClose={() => setCreating(false)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}

/* ── row detail: read-only display — the ONLY interactive element is the
 * Edit button. Address/coords/partner/clients/notes come straight off the
 * list row; the survey summary needs a per-row detail fetch (survey_data
 * isn't in the list projection), lazily loaded only while the row is open,
 * mirroring Workers.tsx's CertsPanel pattern. ───────────────────────── */

function SiteRowDetail({ site, schema, canEdit, onEdit }: {
  site: SiteItem;
  schema: SurveySchema | null;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const [surveyData, setSurveyData] = useState<Record<string, unknown> | null>(null);
  const [surveyStatus, setSurveyStatus] = useState<'loading' | 'loaded' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setSurveyStatus('loading');
    void getSite(site.id).then((detail) => {
      if (cancelled) return;
      setSurveyData(detail.survey_data);
      setSurveyStatus('loaded');
    }).catch(() => {
      if (!cancelled) setSurveyStatus('error');
    });
    return () => { cancelled = true; };
  }, [site.id]);

  const address = [site.address_line1, site.address_line2, [site.city, site.region]
    .filter(Boolean).join(', '), site.postal_code, site.country].filter(Boolean);

  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Address</p>
        {address.length === 0 ? (
          <p className="set-note" style={{ padding: 0 }}>No address on file.</p>
        ) : (
          <p className="site-address">{address.join(' · ')}</p>
        )}

        <p className="eyebrow-sm">Coordinates &amp; timezone</p>
        <dl className="kv">
          <dt>Coordinates</dt>
          <dd className="mono">{formatCoords(site.latitude, site.longitude)}</dd>
          <dt>Timezone</dt>
          <dd>{site.timezone ?? '—'}</dd>
        </dl>

        <p className="eyebrow-sm">Partner &amp; DC provider</p>
        <dl className="kv">
          <dt>Supplying partner</dt>
          <dd>{site.partner_name ?? '—'}</dd>
          <dt>DC provider</dt>
          <dd>{site.dc_provider ?? '—'}</dd>
        </dl>
      </div>

      <div className="detail-block">
        <p className="eyebrow-sm">Clients</p>
        <div className="chips">
          {site.clients.length === 0 && <span className="chip tag">No linked clients</span>}
          {site.clients.map((c) => <span key={c.client_id} className="chip c-blue">{c.name}</span>)}
        </div>

        <p className="eyebrow-sm">Notes</p>
        <p className="set-note" style={{ padding: 0 }}>{site.notes || 'No notes.'}</p>

        <p className="eyebrow-sm">Survey</p>
        {surveyStatus === 'loading' && <p className="set-note" style={{ padding: 0 }}>Loading…</p>}
        {surveyStatus === 'error' && (
          <p className="set-note" style={{ padding: 0 }}>Could not load survey data.</p>
        )}
        {surveyStatus === 'loaded' && (
          <p className="survey-summary">{surveySummary(surveyData, schema)}</p>
        )}
      </div>

      {canEdit && (
        <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
          <button className="btn-solid" onClick={onEdit}>Edit</button>
        </div>
      )}
    </div>
  );
}
