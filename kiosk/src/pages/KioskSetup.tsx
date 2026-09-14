/**
 * Kiosk Setup wizard: pick a move, then which of that move's sites this
 * kiosk is at ("step 1A" — the move's source or destination site), then
 * a scan type, and stamp this kiosk's Device row (POST /kiosk/setup).
 * Tap-to-select card pickers (`.setup-card`, mirroring `.kiosk-tile`) —
 * large touch targets, no native `<select>`. Tapping a move or site card
 * selects it and advances to the next step; tapping a scan-type card
 * saves immediately. Once a selection is saved and setup is complete,
 * shows a summary card instead of the wizard; "Change setup" re-enters
 * the wizard pre-selected. A successful save also kicks off the move's
 * local-data download (`runSync`, not awaited) and the summary's
 * `.sync-status` block reports it.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  ApiError, getSetupOptions, submitKioskSetup, type SetupOptionInitiative,
  type SetupOptions, type SetupOptionSite,
} from '../lib/api';
import { getIdentity } from '../lib/identity';
import { useKioskSetup } from '../lib/kioskSetup';
import {
  isSetupComplete, readSetupState, useKioskSetupState, writeSetupState,
} from '../lib/setupState';
import { formatSyncedAt, runSync, useSyncStatus } from '../lib/sync';

type Step = 1 | 2 | 3;

function formatMoveDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatMoveDates(initiative: SetupOptionInitiative): string | null {
  const start = initiative.scheduled_start ? formatMoveDate(initiative.scheduled_start) : null;
  const end = initiative.scheduled_end ? formatMoveDate(initiative.scheduled_end) : null;
  if (start && end) return `${start} – ${end}`;
  if (start) return `Starts ${start}`;
  if (end) return `Ends ${end}`;
  return null;
}

export default function KioskSetup() {
  const navigate = useNavigate();
  const [setupState] = useKioskSetupState();
  const [selection, setSelection] = useKioskSetup();
  const [wizardOpen, setWizardOpen] = useState(!(selection && isSetupComplete(setupState)));
  const [options, setOptions] = useState<SetupOptions | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [step, setStep] = useState<Step>(1);
  const [initiativeId, setInitiativeId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [scanStatus, setScanStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const sync = useSyncStatus();

  const load = () => {
    setLoadError(false);
    setOptions(null);
    getSetupOptions().then(setOptions).catch(() => setLoadError(true));
  };

  useEffect(() => {
    if (wizardOpen) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardOpen]);

  // Revalidate a preselected (cached) choice against the options that just
  // loaded — a move, site, or scan type saved earlier may no longer exist,
  // may no longer be offered, or (for a site) may no longer belong to the
  // reselected move. Clearing it here, rather than trusting the cache,
  // means step 1 never shows a phantom selection.
  useEffect(() => {
    if (!options) return;
    if (initiativeId && !options.initiatives.some((i) => i.id === initiativeId)) {
      setInitiativeId('');
      setSiteId('');
      setScanStatus('');
      return;
    }
    const initiative = options.initiatives.find((i) => i.id === initiativeId);
    const validSiteIds = [initiative?.source_site?.id, initiative?.destination_site?.id]
      .filter((id): id is string => Boolean(id));
    if (siteId && !validSiteIds.includes(siteId)) setSiteId('');
    if (scanStatus && !options.scan_types.some((s) => s.key === scanStatus)) setScanStatus('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  const openWizard = (preselect: boolean) => {
    if (preselect && selection) {
      setInitiativeId(selection.initiativeId);
      setSiteId(selection.siteId);
      setScanStatus(selection.scanStatus);
    } else {
      setInitiativeId('');
      setSiteId('');
      setScanStatus('');
    }
    setSubmitError('');
    setStep(1);
    setWizardOpen(true);
  };

  const selectedInitiative = options?.initiatives.find((i) => i.id === initiativeId) ?? null;
  const siteChoices: { site: SetupOptionSite; role: 'source' | 'destination' }[] = [];
  if (selectedInitiative?.source_site) {
    siteChoices.push({ site: selectedInitiative.source_site, role: 'source' });
  }
  if (selectedInitiative?.destination_site) {
    siteChoices.push({ site: selectedInitiative.destination_site, role: 'destination' });
  }

  const selectMove = (id: string) => {
    if (id !== initiativeId) setSiteId('');
    setInitiativeId(id);
    setStep(2);
  };

  const selectSite = (id: string) => {
    setSiteId(id);
    setStep(3);
  };

  const finish = async (scanKey: string) => {
    setScanStatus(scanKey);
    setSubmitting(true);
    setSubmitError('');
    try {
      const identity = getIdentity();
      const result = await submitKioskSetup({
        serial: identity.serial, initiative_id: initiativeId, site_id: siteId,
        scan_status: scanKey,
      });
      setSelection({
        initiativeId: result.initiative_id, initiativeName: result.initiative_name,
        siteId: result.site_id, siteName: result.site_name, siteRole: result.site_role,
        scanStatus: result.scan_status, scanLabel: result.scan_status_label,
      });
      writeSetupState('complete');
      setWizardOpen(false);
      // Fire-and-forget: the summary appears immediately and the
      // download reports itself through `.sync-status`. A sync outcome
      // never changes the setup state — the kiosk IS set up either way.
      void runSync(result.initiative_id, result.initiative_name);
    } catch (err) {
      // A transient save failure shouldn't downgrade a kiosk that was
      // already set up and working — only mark 'failed' when it wasn't
      // already 'complete'; the summary stays reachable via Cancel.
      if (readSetupState() !== 'complete') writeSetupState('failed');
      setSubmitError(err instanceof ApiError ? err.code : 'unknown_error');
    } finally {
      setSubmitting(false);
    }
  };

  if (!wizardOpen && selection) {
    const resync = () => { void runSync(selection.initiativeId, selection.initiativeName); };
    return (
      <div className="portal-page">
        <div className="eyebrow">Kiosk · Setup</div>
        <h1 className="page-title">Kiosk setup</h1>
        <div className="setup-summary">
          <p>
            This kiosk is set up for <b>{selection.initiativeName}</b> at{' '}
            <b>{selection.siteName}</b> ({selection.siteRole}) · scan type{' '}
            <b>{selection.scanLabel}</b>
          </p>
          <div className="sync-status">
            {/* idle only happens before a first sync, or after the
                Developer tab's "Clear local data" — without this branch
                that would be a dead end with no way back. */}
            {sync.phase === 'idle' && (
              <>
                <span>No move data on this kiosk yet.</span>
                <button type="button" className="mini-btn" onClick={resync}>Sync now</button>
              </>
            )}
            {sync.phase === 'running' && <span>Downloading move data…</span>}
            {sync.phase === 'done' && (
              <>
                <span>
                  Local data: {sync.assets ?? 0} assets · {sync.people ?? 0} people
                  {sync.syncedAt ? ` · synced ${formatSyncedAt(sync.syncedAt)}` : ''}
                </span>
                <button type="button" className="mini-btn" onClick={resync}>Sync again</button>
              </>
            )}
            {sync.phase === 'error' && (
              <>
                <span className="form-error" role="alert">
                  Couldn&apos;t download move data ({sync.error ?? 'unknown_error'}).
                </span>
                <button type="button" className="mini-btn" onClick={resync}>Try again</button>
              </>
            )}
          </div>
          <div className="setup-actions">
            <button type="button" className="mini-btn" onClick={() => openWizard(true)}>
              Change setup
            </button>
            <button type="button" className="btn-solid" onClick={() => navigate('/')}>
              Go to home
            </button>
          </div>
        </div>
      </div>
    );
  }

  const stepLabel = step === 1 ? 'Step 1 of 3 · Move'
    : step === 2 ? 'Step 2 of 3 · Site' : 'Step 3 of 3 · Scan type';

  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk · Setup</div>
      <h1 className="page-title">Kiosk setup</h1>
      <div className="setup-wizard">
        <div className="setup-steps">{stepLabel}</div>

        {loadError && (
          <>
            <p className="form-error" role="alert">Couldn&apos;t load setup options.</p>
            <button type="button" className="mini-btn" onClick={load}>Retry</button>
          </>
        )}

        {!loadError && options === null && <p className="page-hint">Loading moves…</p>}

        {!loadError && options !== null && step === 1 && (
          <div>
            <h2>Which move?</h2>
            <div className="setup-cards" role="listbox" aria-label="Moves">
              {options.initiatives.map((i) => {
                const dates = formatMoveDates(i);
                return (
                  <button key={i.id} type="button" role="option"
                          aria-selected={initiativeId === i.id} className="setup-card"
                          onClick={() => selectMove(i.id)}>
                    <div className="setup-card-title">{i.name}</div>
                    <span className={`chip ${i.status === 'in_progress' ? 'c-green' : 'tag'}`}>
                      {i.status_label}
                    </span>
                    {i.client_name && <div className="setup-card-meta">{i.client_name}</div>}
                    {dates && <div className="setup-card-meta">{dates}</div>}
                    <div className="setup-card-sites">
                      {i.source_site?.name ?? '—'} → {i.destination_site?.name ?? '—'}
                    </div>
                  </button>
                );
              })}
            </div>
            {options.initiatives.length === 0 && (
              <p className="page-hint">No active moves. Ask a coordinator to plan one.</p>
            )}
            {selection && setupState === 'complete' && (
              <div className="pf-form-actions">
                <button type="button" className="mini-btn" onClick={() => setWizardOpen(false)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}

        {!loadError && options !== null && step === 2 && (
          <div>
            <h2>Which site is this kiosk at?</h2>
            <div className="setup-cards" role="listbox" aria-label="Sites">
              {siteChoices.map(({ site, role }) => (
                <button key={site.id} type="button" role="option"
                        aria-selected={siteId === site.id} className="setup-card"
                        onClick={() => selectSite(site.id)}>
                  <div className="setup-card-role">{role.toUpperCase()}</div>
                  <div className="setup-card-title">{site.name}</div>
                </button>
              ))}
            </div>
            {siteChoices.length === 0 && (
              <p className="page-hint">
                This move has no sites yet. Ask a coordinator to add them.
              </p>
            )}
            <div className="pf-form-actions">
              <button type="button" className="mini-btn" onClick={() => setStep(1)}>Back</button>
            </div>
          </div>
        )}

        {!loadError && options !== null && step === 3 && (
          <div>
            <h2>Which scan type?</h2>
            <div className="setup-cards" role="listbox" aria-label="Scan types">
              {options.scan_types.map((s) => {
                const saving = submitting && scanStatus === s.key;
                return (
                  <button key={s.key} type="button" role="option"
                          aria-selected={scanStatus === s.key}
                          className={`setup-card${saving ? ' is-saving' : ''}`}
                          disabled={submitting} onClick={() => void finish(s.key)}>
                    <span className="dot" style={{ background: s.color }} />
                    <span className="setup-card-title">{saving ? 'Saving…' : s.label}</span>
                  </button>
                );
              })}
            </div>
            {submitError && (
              <p className="form-error" role="alert">
                Couldn&apos;t save the kiosk setup ({submitError}). Try again.
              </p>
            )}
            <div className="pf-form-actions">
              <button type="button" className="mini-btn" onClick={() => setStep(2)}
                      disabled={submitting}>
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
