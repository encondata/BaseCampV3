/**
 * Kiosk Setup wizard. On a laptop it starts by asking what the station is
 * (StationTypeStep): a Label Station goes straight on; an RFID Station
 * first finds, connects to, and pairs a Zebra FX reader (ReaderStep,
 * ConnectStep, PairStep — under components/setup/), then a Network check
 * (NetworkCheckStep). Every path then continues the same way: pick a move, then which of that move's sites this
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
 *
 * A laptop shares its finished setup with every browser (KioskShell loads
 * it from the edge, `lib/laptopSetup.ts`); when it lands after this page
 * opened, an untouched wizard gives way to the summary. Reached through a
 * LAN address, the page says it changes the laptop itself.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import ConfirmStep from '../components/setup/ConfirmStep';
import ConnectStep from '../components/setup/ConnectStep';
import NetworkCheckStep from '../components/setup/NetworkCheckStep';
import PairStep from '../components/setup/PairStep';
import ReaderStep from '../components/setup/ReaderStep';
import StationTypeStep from '../components/setup/StationTypeStep';
import {
  ApiError, CLOUD_SIGN_IN_TEXT, getSetupOptions, submitKioskSetup, type PairResult,
  type ReaderInfo, type SetupOptionInitiative, type SetupOptions, type SetupOptionSite,
} from '../lib/api';
import { getIdentity } from '../lib/identity';
import {
  readerLabel, stationLabel, useKioskSetup, type KioskSetupSelection, type StationType,
} from '../lib/kioskSetup';
import { isLaptop, platform } from '../lib/platform';
import {
  isSetupComplete, readSetupState, useKioskSetupState, writeSetupState,
} from '../lib/setupState';
import { formatSyncedAt, runSync, useSyncStatus } from '../lib/sync';

/** Shown when Kiosk Setup is reached from another device on the LAN. */
const LAN_NOTICE = "You're changing the setup of the laptop itself.";

type Step = 'type' | 'reader' | 'connect' | 'pair' | 'network' | 'move' | 'site' | 'scan' | 'confirm';

const STEP_LABEL: Record<Step, string> = {
  type: 'Station type', reader: 'Select reader', connect: 'Connect', pair: 'Pair',
  network: 'Network check', move: 'Move', site: 'Site', scan: 'Scan type', confirm: 'Confirm & verify',
};

/** The steps this kiosk walks. Web mode skips the station type: RFID
 *  needs the laptop edge, and a web kiosk behaves exactly as before. */
function pathFor(laptop: boolean, stationType: StationType | ''): Step[] {
  if (!laptop) return ['move', 'site', 'scan'];
  if (stationType === 'rfid') return ['type', 'reader', 'connect', 'pair', 'network', 'move', 'site', 'scan', 'confirm'];
  return ['type', 'move', 'site', 'scan'];
}

/** scheduled_start/scheduled_end are date-only fields (midnight UTC for a
 *  plain YYYY-MM-DD input) — read the Y-M-D digits into a local Date
 *  first, since `new Date(iso)` would land on the previous evening west
 *  of UTC and name the day before. `kiosk/` has no `lib/timeline.ts` to
 *  import `parseApiDay` from (it is a separate Vite app from `portal/`),
 *  so the parse is inlined here. */
function formatMoveDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
  const laptop = isLaptop();
  const [stationType, setStationType] = useState<StationType | ''>(
    laptop ? selection?.stationType ?? '' : '');
  const path = pathFor(laptop, stationType);
  const [step, setStep] = useState<Step>(path[0]);
  const [readerIp, setReaderIp] = useState('');
  const [laptopIp, setLaptopIp] = useState('');
  const [connected, setConnected] = useState<ReaderInfo | null>(null);
  const [paired, setPaired] = useState<PairResult | null>(null);
  const [initiativeId, setInitiativeId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [scanStatus, setScanStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const sync = useSyncStatus();
  // An RFID station only offers scan types with RFID in the name.
  const scanTypes = options
    ? (stationType === 'rfid' && laptop
      ? options.scan_types.filter((t) => t.label.toLowerCase().includes('rfid'))
      : options.scan_types)
    : [];
  // A phone on the LAN changes the laptop's own setup, which every browser shares.
  const lanAccess = laptop && window.__KIOSK_CONFIG__?.lanAccess === true;
  // Set once someone acts on the wizard: a setup shared after that never
  // closes it under them.
  const touched = useRef(false);
  const setupComplete = Boolean(selection) && isSetupComplete(setupState);
  useEffect(() => {
    if (setupComplete && !touched.current) setWizardOpen(false);
  }, [setupComplete]);

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
    if (scanStatus && !scanTypes.some((s) => s.key === scanStatus)) setScanStatus('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  const openWizard = (preselect: boolean) => {
    touched.current = true;
    if (preselect && selection) {
      setInitiativeId(selection.initiativeId);
      setSiteId(selection.siteId);
      setScanStatus(selection.scanStatus);
      setStationType(laptop ? selection.stationType ?? '' : '');
      setReaderIp(selection.reader?.ip ?? '');
    } else {
      setInitiativeId('');
      setSiteId('');
      setScanStatus('');
      setStationType('');
      setReaderIp('');
    }
    setLaptopIp('');
    setConnected(null);
    setPaired(null);
    setSubmitError('');
    setStep(laptop ? 'type' : 'move');
    setWizardOpen(true);
  };

  const stepIndex = Math.max(0, path.indexOf(step));
  const back = () => setStep(path[Math.max(0, stepIndex - 1)]);
  const next = () => setStep(path[Math.min(path.length - 1, stepIndex + 1)]);

  const selectStationType = (type: StationType) => {
    touched.current = true;
    setStationType(type);
    setStep(pathFor(laptop, type)[1]);
  };

  /** A reader picked from the scan or typed in; a different reader (or
   *  laptop address) means connecting and pairing again. */
  const pickReader = (ip: string, laptop_ip?: string) => {
    if (ip !== readerIp) setConnected(null);
    setPaired(null);
    setReaderIp(ip);
    setLaptopIp(laptop_ip ?? '');
    setStep('connect');
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
    touched.current = true;
    if (id !== initiativeId) setSiteId('');
    setInitiativeId(id);
    setStep('site');
  };

  const selectSite = (id: string) => {
    setSiteId(id);
    setStep('scan');
  };

  const finish = async (scanKey: string) => {
    setScanStatus(scanKey);
    setSubmitting(true);
    setSubmitError('');
    try {
      const identity = getIdentity();
      // The edge adds the paired reader itself for an RFID station.
      const station = laptop && stationType ? stationType : undefined;
      const result = await submitKioskSetup({
        serial: identity.serial, initiative_id: initiativeId, site_id: siteId,
        scan_status: scanKey, ...(station ? { station_type: station } : {}),
      });
      const saved: KioskSetupSelection = {
        initiativeId: result.initiative_id, initiativeName: result.initiative_name,
        siteId: result.site_id, siteName: result.site_name, siteRole: result.site_role,
        scanStatus: result.scan_status, scanLabel: result.scan_status_label,
      };
      if (station) saved.stationType = station;
      if (station === 'rfid') {
        // Only a reader this run actually paired; the Pair step can't be
        // passed without one.
        const reader = paired?.reader;
        if (reader) saved.reader = { ip: reader.ip, serial: reader.serial, model: reader.model };
      }
      setSelection(saved);
      writeSetupState('complete');
      // An RFID station still has to verify and start its reader.
      if (station === 'rfid') setStep('confirm'); else setWizardOpen(false);
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
        {lanAccess && <p className="sys-banner sys-banner-readonly" role="status">{LAN_NOTICE}</p>}
        <div className="setup-summary">
          <p>
            This kiosk is set up for <b>{selection.initiativeName}</b> at{' '}
            <b>{selection.siteName}</b> ({selection.siteRole}) · scan type{' '}
            <b>{selection.scanLabel}</b>
          </p>
          {laptop && selection.stationType && (
            <p>
              Station: <b>{stationLabel(selection.stationType, platform().label)}</b>
              {selection.stationType === 'rfid' && selection.reader && (
                <> · reader <b>{readerLabel(selection.reader)}</b></>
              )}
            </p>
          )}
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
                  {' · '}{sync.containers ?? 0} containers
                  {' · '}{sync.trucks ?? 0} trucks
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

  // Before a station type is picked the path's length isn't known yet.
  const stepLabel = step === 'type' && !stationType
    ? `Step 1 · ${STEP_LABEL.type}`
    : `Step ${stepIndex + 1} of ${path.length} · ${STEP_LABEL[step]}`;
  const moveStep = step === 'move' || step === 'site' || step === 'scan';
  const canCancel = Boolean(selection) && setupState === 'complete';

  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk · Setup</div>
      <h1 className="page-title">Kiosk setup</h1>
      {lanAccess && <p className="sys-banner sys-banner-readonly" role="status">{LAN_NOTICE}</p>}
      <div className="setup-wizard">
        <div className="setup-steps">{stepLabel}</div>

        {step === 'type' && (
          <div>
            <StationTypeStep selected={stationType} onSelect={selectStationType} />
            {canCancel && (
              <div className="pf-form-actions">
                <button type="button" className="mini-btn" onClick={() => setWizardOpen(false)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}

        {step === 'reader' && (
          <div><ReaderStep selectedIp={readerIp} onPick={pickReader} onBack={back} /></div>
        )}

        {step === 'connect' && (
          <div>
            <ConnectStep ip={readerIp} info={connected} onInfo={setConnected}
                         onPair={next} onBack={back} />
          </div>
        )}

        {step === 'pair' && (
          <div>
            <PairStep ip={readerIp} laptopIp={laptopIp} result={paired} onResult={setPaired}
                      onContinue={next} onBack={back} onCancel={back} onManual={pickReader} />
          </div>
        )}

        {step === 'network' && <div><NetworkCheckStep onContinue={next} onBack={back} /></div>}

        {step === 'confirm' && selection && (
          <div>
            <ConfirmStep
              setup={selection}
              reader={paired?.reader
                ? { ip: paired.reader.ip, serial: paired.reader.serial,
                    model: paired.reader.model, endpoint_url: paired.endpoint_url }
                : null}
              onBack={() => setStep('scan')}
              onPairAgain={() => setStep('reader')}
              onStarted={() => { setWizardOpen(false); navigate('/rfid_status'); }} />
          </div>
        )}

        {moveStep && loadError && (
          <>
            <p className="form-error" role="alert">Couldn&apos;t load setup options.</p>
            <button type="button" className="mini-btn" onClick={load}>Retry</button>
          </>
        )}

        {moveStep && !loadError && options === null && <p className="page-hint">Loading moves…</p>}

        {!loadError && options !== null && step === 'move' && (
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
            {path[0] === 'move' ? (
              canCancel && (
                <div className="pf-form-actions">
                  <button type="button" className="mini-btn" onClick={() => setWizardOpen(false)}>
                    Cancel
                  </button>
                </div>
              )
            ) : (
              <div className="pf-form-actions">
                <button type="button" className="mini-btn" onClick={back}>Back</button>
              </div>
            )}
          </div>
        )}

        {!loadError && options !== null && step === 'site' && (
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
              <button type="button" className="mini-btn" onClick={back}>Back</button>
            </div>
          </div>
        )}

        {!loadError && options !== null && step === 'scan' && (
          <div>
            <h2>Which scan type?</h2>
            <div className="setup-cards" role="listbox" aria-label="Scan types">
              {scanTypes.map((s) => {
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
            {scanTypes.length === 0 && stationType === 'rfid' && laptop && (
              <p className="page-hint">
                No RFID scan types are set up. Add an active status value with RFID in its name
                on the portal&apos;s Variables page.
              </p>
            )}
            {submitError && submitError !== 'reader_required' && (
              <p className="form-error" role="alert">
                {submitError === 'cloud_sign_in_required'
                  ? CLOUD_SIGN_IN_TEXT
                  : <>Couldn&apos;t save the kiosk setup ({submitError}). Try again.</>}
              </p>
            )}
            {/* The edge had no paired reader for an RFID station. */}
            {submitError === 'reader_required' && (
              <div className="form-error" role="alert">
                <p>Pair a reader first</p>
                {path.includes('reader') && (
                  <button type="button" className="mini-btn"
                          onClick={() => { setSubmitError(''); setStep('reader'); }}>
                    Back to the reader step
                  </button>
                )}
              </div>
            )}
            <div className="pf-form-actions">
              <button type="button" className="mini-btn" onClick={back}
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
