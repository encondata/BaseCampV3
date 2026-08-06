/**
 * SiteEditModal — the only place a site is ever mutated: field edits,
 * client links, survey answers, and archive/unarchive. `site === null`
 * opens the modal in create mode; once createSite succeeds the modal
 * flips itself to edit mode for the created record (see the
 * needsSiteCreate/afterSiteClientsFailure trap in lib/sites.ts) so a
 * retry after a failed client-link step never re-creates the site.
 *
 * Follows the modal-scrim/modal-card/modal-head/modal-body/modal-foot
 * conventions from pages/External.tsx.
 */

import { useEffect, useState, type FormEvent } from 'react';

import ComboBox from '../ComboBox';
import {
  ApiError,
  archiveSite,
  createSite,
  getSite,
  getSurveySchema,
  saveSiteSurvey,
  setSiteClients,
  updateSite,
  type SiteItem,
  type SiteLookup,
  type SurveySchema,
} from '../../lib/api';
import {
  afterSiteClientsFailure,
  formFromSite,
  needsSiteCreate,
  sameClientSet,
  SITE_CREATED_UNLINKED_MESSAGE,
  SITE_ERRORS,
  sitePayload,
  surveyChanged,
  surveyPayload,
  type SiteFormState,
} from '../../lib/sites';
import SiteBulkImport from './SiteBulkImport';
import SurveyForm from './SurveyForm';

interface OrgRef { id: string; name: string; archived_at?: string | null }

interface Props {
  site: SiteItem | null;          // null = create mode
  types: SiteLookup[];
  statuses: SiteLookup[];
  clients: OrgRef[];
  partners: OrgRef[];
  canChange: boolean;
  canBulk?: boolean;              // admin-rank gate for the Bulk tab (create mode)
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

function mapError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (SITE_ERRORS[err.code] ?? fallback) : 'Network error.';
}

export default function SiteEditModal({
  site, types, statuses, clients, partners, canChange, canBulk = false,
  onClose, onSaved,
}: Props) {
  const isCreateMode = site === null;
  const [mode, setMode] = useState<'single' | 'bulk'>('single');

  const [createdId, setCreatedId] = useState<string | null>(null);
  const editingId = site?.id ?? createdId; // non-null once a record exists to edit

  const [form, setForm] = useState<SiteFormState>(() => formFromSite(site));
  const [clientIds, setClientIds] = useState<string[]>(
    () => site?.clients.map((c) => c.client_id) ?? []);
  const [clientBaseline, setClientBaseline] = useState<string[]>(clientIds);
  const [surveyValues, setSurveyValues] = useState<Record<string, unknown>>({});
  const [surveyBaseline, setSurveyBaseline] = useState<Record<string, unknown>>({});
  const [schema, setSchema] = useState<SurveySchema | null>(null);
  const [archived, setArchived] = useState<boolean>(!!site?.archived_at);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const locked = saving || (!needsSiteCreate({ isCreateMode, createdId }) && !canChange);

  useEffect(() => {
    void getSurveySchema().then(setSchema).catch(() => {});
  }, []);

  // Load survey answers once a record exists to load them for (an existing
  // site being edited, or a site just created in this session).
  useEffect(() => {
    if (!editingId) return;
    let cancelled = false;
    void getSite(editingId).then((detail) => {
      if (cancelled) return;
      setSurveyValues(detail.survey_data ?? {});
      setSurveyBaseline(detail.survey_data ?? {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [editingId]);

  const setField = (key: keyof SiteFormState, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (needsSiteCreate({ isCreateMode, createdId })) {
        const created = await createSite(sitePayload(form));
        setCreatedId(created.id);
        setArchived(!!created.archived_at);

        if (clientIds.length > 0) {
          try {
            await setSiteClients(created.id, clientIds);
            setClientBaseline(clientIds);
          } catch (err) {
            const reason = err instanceof ApiError ? SITE_ERRORS[err.code] : undefined;
            setNotice(afterSiteClientsFailure(created.id, reason) ?? SITE_CREATED_UNLINKED_MESSAGE);
            setClientBaseline([]);
            setSaving(false);
            await onSaved(); // the site itself exists now — reflect it in the list
            return;
          }
        } else {
          setClientBaseline([]);
        }

        setNotice('');
        await onSaved();
        onClose();
        return;
      }

      const id = editingId as string;
      await updateSite(id, sitePayload(form));

      try {
        if (!sameClientSet(clientBaseline, clientIds)) {
          await setSiteClients(id, clientIds);
          setClientBaseline(clientIds);
        }

        if (schema && surveyChanged(surveyBaseline, surveyValues, schema)) {
          await saveSiteSurvey(id, surveyPayload(surveyValues, schema));
          setSurveyBaseline(surveyValues);
        }
      } catch (err) {
        setError(mapError(err, 'Could not save — try again.'));
        setSaving(false);
        await onSaved(); // the field changes already persisted — reflect them in the list
        return;
      }

      setNotice('');
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapError(err, 'Could not save — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async () => {
    if (!editingId) return;
    setSaving(true);
    setError('');
    try {
      await archiveSite(editingId, !archived);
      setArchived((v) => !v);
      await onSaved();
    } catch (err) {
      setError(mapError(err, 'Could not change the archive state — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const title = editingId ? `Edit — ${form.name || 'Site'}` : 'New site';

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>{mode === 'bulk' ? 'Bulk import sites' : title}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        {isCreateMode && canBulk && createdId === null && (
          <div className="modal-mode-toggle" role="tablist" aria-label="Create mode">
            <button type="button" role="tab" aria-selected={mode === 'single'}
                    className={`mini-btn ${mode === 'single' ? 'active' : ''}`}
                    onClick={() => setMode('single')}>
              Single site
            </button>
            <button type="button" role="tab" aria-selected={mode === 'bulk'}
                    className={`mini-btn ${mode === 'bulk' ? 'active' : ''}`}
                    onClick={() => setMode('bulk')}>
              Bulk import
            </button>
          </div>
        )}
        {mode === 'bulk' ? (
          <div className="modal-body">
            <SiteBulkImport onDone={async () => { await onSaved(); }} />
          </div>
        ) : (
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            {notice && (
              <p style={{ fontSize: 12.5, color: 'var(--c-amber)', margin: '0 0 14px' }}>
                {notice}
              </p>
            )}

            <div className="modal-section">Details</div>
            <div className="pf-form">
              <div><label>Name *</label>
                <input value={form.name} disabled={locked} required
                       onChange={(e) => setField('name', e.target.value)} /></div>
              <div><label>Code</label>
                <input value={form.code} disabled={locked}
                       onChange={(e) => setField('code', e.target.value)} /></div>
              <div><label>Type</label>
                <select className="org-select" value={form.site_type} disabled={locked}
                        onChange={(e) => setField('site_type', e.target.value)}>
                  <option value="">No type set</option>
                  {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select></div>
              <div><label>Status</label>
                <select className="org-select" value={form.status} disabled={locked}
                        onChange={(e) => setField('status', e.target.value)}>
                  <option value="">Use server default</option>
                  {statuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select></div>
            </div>

            <div className="modal-section">Address</div>
            <div className="pf-form">
              <div className="full"><label>Address line 1</label>
                <input value={form.address_line1} disabled={locked}
                       onChange={(e) => setField('address_line1', e.target.value)} /></div>
              <div className="full"><label>Address line 2</label>
                <input value={form.address_line2} disabled={locked}
                       onChange={(e) => setField('address_line2', e.target.value)} /></div>
              <div><label>City</label>
                <input value={form.city} disabled={locked}
                       onChange={(e) => setField('city', e.target.value)} /></div>
              <div><label>Region</label>
                <input value={form.region} disabled={locked}
                       onChange={(e) => setField('region', e.target.value)} /></div>
              <div><label>Postal code</label>
                <input value={form.postal_code} disabled={locked}
                       onChange={(e) => setField('postal_code', e.target.value)} /></div>
              <div><label>Country</label>
                <input value={form.country} disabled={locked}
                       onChange={(e) => setField('country', e.target.value)} /></div>
            </div>

            <div className="modal-section">Location</div>
            <div className="pf-form">
              <div><label>Latitude</label>
                <input type="number" step="any" value={form.latitude} disabled={locked}
                       onChange={(e) => setField('latitude', e.target.value)} /></div>
              <div><label>Longitude</label>
                <input type="number" step="any" value={form.longitude} disabled={locked}
                       onChange={(e) => setField('longitude', e.target.value)} /></div>
              <div className="full">
                <p className="set-note" style={{ padding: 0, margin: '-6px 0 0' }}>
                  Set both or neither.
                </p>
              </div>
              <div><label>Timezone</label>
                <input value={form.timezone} disabled={locked}
                       onChange={(e) => setField('timezone', e.target.value)} /></div>
              <div><label>DC provider</label>
                <input value={form.dc_provider} disabled={locked}
                       onChange={(e) => setField('dc_provider', e.target.value)} /></div>
            </div>

            <div className="modal-section">Relationships</div>
            <div className="pf-form">
              <div className="full"><label>Supplying partner</label>
                <ComboBox
                  placeholder="Type to search partners…"
                  value={form.partner_id}
                  clearable
                  disabled={locked}
                  onChange={(v) => setField('partner_id', v)}
                  options={partners
                    .filter((p) => !p.archived_at || p.id === form.partner_id)
                    .map((p) => ({ value: p.id, label: p.name }))}
                /></div>
              <div className="full">
                <label>Clients</label>
                <ComboBox
                  placeholder="Add a client…"
                  value=""
                  disabled={locked}
                  onChange={(v) => {
                    if (v && !clientIds.includes(v)) setClientIds((ids) => [...ids, v]);
                  }}
                  options={clients
                    .filter((c) => !clientIds.includes(c.id) && !c.archived_at)
                    .map((c) => ({ value: c.id, label: c.name }))}
                />
                <div className="chips" style={{ marginTop: 8 }}>
                  {clientIds.length === 0 && <span className="chip tag">No linked clients</span>}
                  {clientIds.map((id) => {
                    const c = clients.find((x) => x.id === id);
                    return (
                      <span key={id} className="chip c-blue tag-chip">
                        {c?.name ?? id}
                        {!locked && (
                          <button type="button" aria-label={`Remove ${c?.name ?? id}`}
                                  onClick={() => setClientIds((ids) => ids.filter((x) => x !== id))}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
                                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
                          </button>
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="modal-section">Notes</div>
            <div className="pf-form">
              <div className="full">
                <label>Notes</label>
                <textarea value={form.notes} disabled={locked} rows={3}
                          onChange={(e) => setField('notes', e.target.value)} />
              </div>
            </div>

            <div className="modal-section">Survey</div>
            {editingId && schema ? (
              <SurveyForm
                schema={schema}
                values={surveyValues}
                disabled={locked}
                onChange={(key, value) => setSurveyValues((v) => ({ ...v, [key]: value }))}
              />
            ) : (
              <p className="set-note">
                Save the site first — the survey form appears once it exists.
              </p>
            )}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving
                ? 'Saving…'
                : (needsSiteCreate({ isCreateMode, createdId }) ? 'Create site' : 'Save')}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {editingId && canChange && (
              <button className="mini-btn danger" type="button" disabled={saving}
                      onClick={() => void toggleArchive()}>
                {archived ? 'Unarchive' : 'Archive'}
              </button>
            )}
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
        )}
      </div>
    </div>
  );
}
