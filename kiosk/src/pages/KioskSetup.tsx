/**
 * Kiosk Setup wizard: pick a move, then which of that move's sites this
 * kiosk is at ("step 1A" — the move's source or destination site), then
 * a scan type, and stamp this kiosk's Device row (POST /kiosk/setup).
 * Native <select> elements — the portal's ComboBox is a .tsx the kiosk
 * cannot import, and large touch targets matter more here than the
 * portal's picker affordances. Once a selection is saved and setup is
 * complete, shows a summary card instead of the wizard; "Change setup"
 * re-enters the wizard pre-selected.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  ApiError, getSetupOptions, submitKioskSetup, type SetupOptions, type SetupOptionSite,
} from '../lib/api';
import { getIdentity } from '../lib/identity';
import { useKioskSetup } from '../lib/kioskSetup';
import { isSetupComplete, useKioskSetupState, writeSetupState } from '../lib/setupState';

type Step = 1 | 2 | 3;

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

  const load = () => {
    setLoadError(false);
    setOptions(null);
    getSetupOptions().then(setOptions).catch(() => setLoadError(true));
  };

  useEffect(() => {
    if (wizardOpen) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardOpen]);

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

  const finish = async () => {
    setSubmitting(true);
    setSubmitError('');
    try {
      const identity = getIdentity();
      const result = await submitKioskSetup({
        serial: identity.serial, initiative_id: initiativeId, site_id: siteId,
        scan_status: scanStatus,
      });
      setSelection({
        initiativeId: result.initiative_id, initiativeName: result.initiative_name,
        siteId: result.site_id, siteName: result.site_name, siteRole: result.site_role,
        scanStatus: result.scan_status, scanLabel: result.scan_status_label,
      });
      writeSetupState('complete');
      setWizardOpen(false);
    } catch (err) {
      writeSetupState('failed');
      setSubmitError(err instanceof ApiError ? err.code : 'unknown_error');
    } finally {
      setSubmitting(false);
    }
  };

  if (!wizardOpen && selection) {
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
          <form className="pf-form" noValidate
                onSubmit={(e) => { e.preventDefault(); setStep(2); }}>
            <div className="full">
              <label htmlFor="setup-move">Move</label>
              <select id="setup-move" value={initiativeId}
                      onChange={(e) => { setInitiativeId(e.target.value); setSiteId(''); }}>
                <option value="" disabled>Choose a move…</option>
                {options.initiatives.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}{i.status === 'planned' ? ' (planned)' : ''}
                  </option>
                ))}
              </select>
            </div>
            {options.initiatives.length === 0 && (
              <p className="page-hint full">No active moves. Ask a coordinator to plan one.</p>
            )}
            <div className="pf-form-actions full">
              <button type="submit" className="btn-solid" disabled={!initiativeId}>Next</button>
            </div>
          </form>
        )}

        {!loadError && options !== null && step === 2 && (
          <form className="pf-form" noValidate
                onSubmit={(e) => { e.preventDefault(); setStep(3); }}>
            <h2 className="full">Which site is this kiosk at?</h2>
            <div className="full">
              <label htmlFor="setup-site">Site</label>
              <select id="setup-site" value={siteId}
                      onChange={(e) => setSiteId(e.target.value)}>
                <option value="" disabled>Choose a site…</option>
                {siteChoices.map(({ site, role }) => (
                  <option key={site.id} value={site.id}>{site.name} — {role}</option>
                ))}
              </select>
            </div>
            {siteChoices.length === 0 && (
              <p className="page-hint full">
                This move has no sites yet. Ask a coordinator to add them.
              </p>
            )}
            <div className="pf-form-actions full">
              <button type="button" className="mini-btn" onClick={() => setStep(1)}>Back</button>
              <button type="submit" className="btn-solid" disabled={!siteId}>Next</button>
            </div>
          </form>
        )}

        {!loadError && options !== null && step === 3 && (
          <form className="pf-form" noValidate
                onSubmit={(e) => { e.preventDefault(); void finish(); }}>
            <div className="full">
              <label htmlFor="setup-scan">Scan type</label>
              <select id="setup-scan" value={scanStatus}
                      onChange={(e) => setScanStatus(e.target.value)}>
                <option value="" disabled>Choose a scan type…</option>
                {options.scan_types.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>
            {submitError && (
              <p className="form-error full" role="alert">
                Couldn&apos;t save the kiosk setup ({submitError}). Try again.
              </p>
            )}
            <div className="pf-form-actions full">
              <button type="button" className="mini-btn" onClick={() => setStep(2)}>Back</button>
              <button type="submit" className="btn-solid" disabled={!scanStatus || submitting}>
                {submitting ? 'Saving…' : 'Finish'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
