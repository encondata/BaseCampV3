/**
 * GenerateReportModal's options step for `report_type === 'site_move_survey'`.
 * The initiative itself is picked by the shared "pick" step (with a "No
 * initiative — choose sites manually" choice added there for this report
 * type) — this component receives the result (`initiative: InitiativeItem
 * | null`) and covers everything after it: partner (auto-selected from
 * the move's shipping partner when possible), company contact (defaults
 * to the signed-in user), the source/destination sites (auto-detected
 * from a move, overridable), an assets preview with a condensed/per-asset
 * toggle (or an asset-notes textarea when the move has none), and the
 * three per-run option switches. Generate is gated on a partner plus an
 * initiative or a source site plus the report definition carrying a
 * `survey_template` attachment (the xlsx a run fills — uploaded on the
 * definition's Files, not on the partner); when the source site is
 * missing required survey answers it opens `CompleteSiteSurveyModal`
 * before queuing the run.
 */
import { useEffect, useMemo, useState } from 'react';

import {
  ApiError, getSurveySchema, listAttachments, listInitiativeAssets, listSites,
  listSiteSurvey, listSurveyPartners, listUsers,
  type InitiativeAssetRow, type InitiativeItem, type ReportDefinition, type SiteItem,
  type SurveyPartnerOption, type SurveySchema, type UserSummary,
} from '../../lib/api';
import {
  assetPreviewRows, buildRunOptions, findMissingRequiredFields,
  type MissingSurveyField,
} from '../../lib/siteMoveSurvey';
import { useAuth } from '../../auth/AuthContext';
import ComboBox from '../ComboBox';
import { Switch } from '../Switch';
import CompleteSiteSurveyModal, { saveSurveyValues } from './CompleteSiteSurveyModal';

export default function SiteMoveSurveyOptions({ definition, initiative, onBack, onGenerate }: {
  definition: ReportDefinition;
  /** Already picked by GenerateReportModal's shared "pick" step; `null`
   *  when the requester chose "No initiative — choose sites manually". */
  initiative: InitiativeItem | null;
  onBack: () => void;
  // `options` is really `SiteMoveSurveyRunOptions` (see buildRunOptions),
  // but declared as the wider `Record<string, unknown>` here so it slots
  // straight into GenerateReportModal's report_type-agnostic run payload.
  onGenerate: (payload: {
    initiative_id: string | null; options: Record<string, unknown>; notify: boolean;
  }) => void;
}) {
  const { person } = useAuth();

  const [partners, setPartners] = useState<SurveyPartnerOption[] | null>(null);
  const [partnerId, setPartnerId] = useState('');
  const [partnerTouched, setPartnerTouched] = useState(false);

  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [contactId, setContactId] = useState(() => person?.id ?? '');

  const [sites, setSites] = useState<SiteItem[] | null>(null);
  const [sourceOverride, setSourceOverride] = useState(false);
  const [destOverride, setDestOverride] = useState(false);
  const [manualSourceId, setManualSourceId] = useState('');
  const [manualDestId, setManualDestId] = useState('');

  const [assets, setAssets] = useState<InitiativeAssetRow[]>([]);
  const [condensed, setCondensed] = useState(() => !!definition.options.condensed_assets);
  const [assetNotes, setAssetNotes] = useState('');

  const [hasStandardsDoc, setHasStandardsDoc] = useState(false);
  // The survey template now lives on the report definition (several may
  // exist; the newest is the one a run fills), not on the partner — see
  // EditDefinitionModal's Files section, which is where staff upload it.
  const [hasTemplate, setHasTemplate] = useState(false);
  const [includeStandards, setIncludeStandards] = useState(
    () => !!definition.options.include_transportation_standards);
  const [includePhotos, setIncludePhotos] = useState(
    () => !!definition.options.include_site_photos);
  const [notify, setNotify] = useState(false);

  const [schema, setSchema] = useState<SurveySchema | null>(null);
  const [missingSurvey, setMissingSurvey] = useState<
    { siteId: string; siteName: string; fields: MissingSurveyField[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [generateError, setGenerateError] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listSurveyPartners(), listUsers(), listSites(),
      listAttachments('report_definition', definition.id), getSurveySchema(),
    ]).then(([p, u, s, files, sch]) => {
      if (cancelled) return;
      setPartners(p);
      setUsers(u);
      setSites(s);
      setHasStandardsDoc(files.some(
        (f) => f.kind === 'report_asset' && f.filename.toLowerCase().endsWith('.docx')));
      setHasTemplate(files.some((f) => f.kind === 'survey_template'));
      setSchema(sch);
    }).catch(() => { if (!cancelled) setLoadError("Couldn't load the generate options."); });
    return () => { cancelled = true; };
  }, [definition.id]);

  useEffect(() => {
    if (!initiative) { setAssets([]); return; }
    let cancelled = false;
    listInitiativeAssets(initiative.id)
      .then((rows) => { if (!cancelled) setAssets(rows); })
      .catch(() => { if (!cancelled) setAssets([]); });
    return () => { cancelled = true; };
  }, [initiative]);

  // Auto-select the move's shipping partner once it's known to be a
  // logistics partner in the picker — but only until the user picks one
  // themselves, so the auto-pick never fights a manual choice.
  useEffect(() => {
    if (partnerTouched || !partners || !initiative?.shipping_partner_id) return;
    if (partners.some((p) => p.id === initiative.shipping_partner_id)) {
      setPartnerId(initiative.shipping_partner_id);
    }
  }, [initiative, partners, partnerTouched]);

  const autoSourceId = initiative?.origin_site_id ?? null;
  const autoSourceName = initiative?.origin_site_name ?? null;
  const autoDestId = initiative?.destination_site_id ?? null;
  const autoDestName = initiative?.destination_site_name ?? null;

  const sourceSiteId = autoSourceId && !sourceOverride ? autoSourceId : manualSourceId;
  const destinationSiteId = autoDestId && !destOverride ? autoDestId : manualDestId;

  const siteOptions = useMemo(
    () => (sites ?? []).map((s) => ({ value: s.id, label: s.name })), [sites]);
  const selectedContact = users?.find((u) => u.person_id === contactId) ?? null;
  const previewRows = useMemo(() => assetPreviewRows(assets, condensed), [assets, condensed]);
  // A disabled switch that still reads "on" would be misleading — force it
  // off (and off in the payload) whenever there's no docx to append.
  const effectiveIncludeStandards = includeStandards && hasStandardsDoc;

  const canGenerate = !!partnerId && (!!initiative || !!sourceSiteId) && hasTemplate;

  const proceed = () => {
    const options = buildRunOptions({
      partnerId, contactPersonId: contactId, sourceSiteId, destinationSiteId,
      assetNotes, includeTransportationStandards: effectiveIncludeStandards,
      includeSitePhotos: includePhotos, condensedAssets: condensed,
    });
    onGenerate({
      initiative_id: initiative?.id ?? null,
      // `options`'s own shape (SiteMoveSurveyRunOptions) has no index
      // signature, so it needs an explicit widen for the report-agnostic
      // payload type GenerateReportModal's `createReportRun` call expects.
      options: options as unknown as Record<string, unknown>, notify,
    });
  };

  const generate = async () => {
    if (!canGenerate) return;
    setGenerateError('');
    if (sourceSiteId && schema) {
      setChecking(true);
      try {
        const rows = await listSiteSurvey(sourceSiteId);
        const answers = Object.fromEntries(rows.map((r) => [r.field_key, r.value]));
        const missing = findMissingRequiredFields(schema, answers);
        if (missing.length > 0) {
          const name = sourceSiteId === autoSourceId
            ? (autoSourceName ?? '') : (sites?.find((s) => s.id === sourceSiteId)?.name ?? '');
          setMissingSurvey({ siteId: sourceSiteId, siteName: name, fields: missing });
          setChecking(false);
          return;
        }
      } catch (err) {
        setGenerateError(err instanceof ApiError ? err.message
          : "Couldn't check the source site's survey.");
        setChecking(false);
        return;
      }
      setChecking(false);
    }
    proceed();
  };

  return (
    <>
      <div className="modal-body">
        {!hasTemplate && (
          <p className="pf-notice">
            This report has no survey template yet. Upload an .xlsx template under Edit report ›
            Files.
          </p>
        )}
        <div className="modal-section">Partner</div>
        <div className="pf-form">
          <div>
            <label>Logistics partner</label>
            <ComboBox
              placeholder="Type to search partners…"
              value={partnerId}
              clearable
              onChange={(v) => { setPartnerTouched(true); setPartnerId(v); }}
              options={(partners ?? []).map((p) => ({ value: p.id, label: p.name }))}
            />
          </div>
        </div>

        <div className="modal-section">Company contact</div>
        <div className="pf-form">
          <div>
            <label>Contact</label>
            <ComboBox
              placeholder="Type to search people…"
              value={contactId}
              clearable
              onChange={setContactId}
              options={(users ?? []).map((u) => ({ value: u.person_id, label: u.display_name }))}
            />
            {selectedContact && (
              <span className="page-hint">{selectedContact.login_email ?? '—'}</span>
            )}
          </div>
        </div>

        <div className="modal-section">Sites</div>
        <div className="pf-form">
          <div>
            <label>Source site</label>
            {autoSourceId && !sourceOverride ? (
              <div className="mini-row flex">
                <span className="cell-top">{autoSourceName}</span>
                <span className="chip c-slate">Auto-detected</span>
                <button type="button" className="mini-btn" aria-label="Change source site"
                        onClick={() => setSourceOverride(true)}>
                  Change
                </button>
              </div>
            ) : (
              <ComboBox
                placeholder="Type to search source sites…"
                value={manualSourceId}
                clearable
                onChange={setManualSourceId}
                options={siteOptions}
              />
            )}
          </div>
          <div>
            <label>Destination site</label>
            {autoDestId && !destOverride ? (
              <div className="mini-row flex">
                <span className="cell-top">{autoDestName}</span>
                <span className="chip c-slate">Auto-detected</span>
                <button type="button" className="mini-btn" aria-label="Change destination site"
                        onClick={() => setDestOverride(true)}>
                  Change
                </button>
              </div>
            ) : (
              <ComboBox
                placeholder="Type to search destination sites…"
                value={manualDestId}
                clearable
                onChange={setManualDestId}
                options={siteOptions}
              />
            )}
          </div>
        </div>

        <div className="modal-section">Assets</div>
        {assets.length > 0 ? (
          <>
            <div className="segmented" role="tablist" style={{ marginBottom: 8 }}>
              <button type="button" role="tab" aria-selected={condensed}
                      className={condensed ? 'on' : ''} onClick={() => setCondensed(true)}>
                Condensed by make/model
              </button>
              <button type="button" role="tab" aria-selected={!condensed}
                      className={!condensed ? 'on' : ''} onClick={() => setCondensed(false)}>
                Per asset
              </button>
            </div>
            <ul className="mini-list">
              {previewRows.map((r) => (
                <li key={r.key} className="mini-row flex">
                  <span className="cell-top">{r.make} {r.model}</span>
                  {r.ru != null && <span className="cell-sub">{r.ru}U</span>}
                  <span className="mono">×{r.qty}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="pf-form">
            <div style={{ gridColumn: '1 / -1' }}>
              <p className="page-hint">
                {initiative
                  ? 'No assets associated with this initiative. Notes you enter below will be inserted into the generated survey in place of the equipment listing.'
                  : "No initiative selected, so there's no equipment list. Notes you enter below will be inserted into the generated survey in place of the equipment listing."}
              </p>
              <label htmlFor="survey-asset-notes">Asset notes (optional)</label>
              <textarea id="survey-asset-notes" rows={3}
                        placeholder="e.g. Equipment list will be provided separately. Approximately 40 1U servers and 6 storage arrays."
                        value={assetNotes} onChange={(e) => setAssetNotes(e.target.value)} />
            </div>
          </div>
        )}

        <div className="modal-section">Options</div>
        <div className="mini-list report-sections">
          <label className="mini-row report-section-row">
            <Switch checked={effectiveIncludeStandards} disabled={!hasStandardsDoc}
                    onChange={setIncludeStandards} />
            <span className="report-section-text">
              <span className="cell-top">Include Transportation Standards</span>
              <span className="cell-sub">
                {hasStandardsDoc
                  ? 'Append the company Transportation Standards document as a sheet.'
                  : "Upload a Transportation Standards document on this report's Files first."}
              </span>
            </span>
          </label>
          <label className="mini-row report-section-row">
            <Switch checked={includePhotos} onChange={setIncludePhotos} />
            <span className="report-section-text">
              <span className="cell-top">Include site photos</span>
              <span className="cell-sub">Append a Site Photos sheet from each site's photo attachments.</span>
            </span>
          </label>
          <label className="mini-row report-section-row">
            <Switch checked={notify} onChange={setNotify} />
            <span className="report-section-text">
              <span className="cell-top">Notify me</span>
              <span className="cell-sub">Get an inbox notification when the report is ready.</span>
            </span>
          </label>
        </div>

        {(loadError || generateError) && <p className="pf-error">{loadError || generateError}</p>}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn-ghost" onClick={onBack}>Back</button>
        <button type="button" className="btn-solid" disabled={!canGenerate || checking}
                onClick={() => void generate()}>
          {checking ? 'Checking…' : 'Generate Report'}
        </button>
      </div>

      {missingSurvey && (
        <CompleteSiteSurveyModal
          siteName={missingSurvey.siteName}
          fields={missingSurvey.fields}
          onCancel={() => setMissingSurvey(null)}
          onSave={async (values) => {
            await saveSurveyValues(missingSurvey.siteId, values);
            setMissingSurvey(null);
            proceed();
          }}
        />
      )}
    </>
  );
}
