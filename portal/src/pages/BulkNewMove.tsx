/**
 * BulkNewMove — /bulk/new-move, Bulk Actions › Create a move in steps.
 * Five screens share one WizardHeader and one footer idiom. The wizard's
 * state lives in a server-side draft (created on step 1's Next); nothing
 * real is created until Review › Create move. Leaving with a draft open
 * asks "Discard this move setup?" and deletes the draft on confirm; any
 * other unmount (the back button) deletes it without asking — a draft can
 * never be resumed, and the worker's 24-hour sweep is only the backstop.
 * Once Create is queued or running the worker owns the draft: leaving asks
 * only whether to go (the move finishes anyway) and never deletes. The
 * route checks one permission; the page checks all three the API needs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import WizardHeader from '../components/common/WizardHeader';
import AssetsStep from '../components/moveSetup/AssetsStep';
import CratesStep from '../components/moveSetup/CratesStep';
import DiscardDialog from '../components/moveSetup/DiscardDialog';
import MoveStep from '../components/moveSetup/MoveStep';
import ReviewStep from '../components/moveSetup/ReviewStep';
import TrucksStep from '../components/moveSetup/TrucksStep';
import {
  deleteMoveSetup, listClients, listContainerTypes, listInitiativeStatuses,
  listInitiativeSubTypes, listInitiativeTypes, listPartners, listShippingTypes, listSites,
  patchMoveSetup, type ImportJobOut, type MoveSetupDraft,
} from '../lib/api';
import { formFromInitiative, type InitiativeFormState } from '../lib/initiatives';
import {
  EMPTY_LOOKUPS, initialCrates, initialTrucks, MOVE_SETUP_NO_ACCESS, MOVE_SETUP_PERMISSIONS,
  MOVE_SETUP_STEPS, type CratesValue, type MoveSetupLookups, type SkippableSection,
  type TrucksValue,
} from '../lib/moveSetup';
import { useLeaveGuard } from '../lib/useLeaveGuard';
import '../styles/bulk.css';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/profile.css';
import '../styles/settings.css';
import '../styles/wizard.css';
import '../styles/moveSetup.css';

export default function BulkNewMove() {
  const { can } = useAuth();
  if (!MOVE_SETUP_PERMISSIONS.every(([resource, action]) => can(resource, action))) {
    return (
      <div className="portal-page">
        <div className="eyebrow">Bulk Actions</div>
        <h1 className="page-title">Create a move in steps</h1>
        <p className="page-hint">{MOVE_SETUP_NO_ACCESS}</p>
      </div>
    );
  }
  return <MoveSetupWizard />;
}

function MoveSetupWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<MoveSetupDraft | null>(null);
  const [form, setForm] = useState<InitiativeFormState>(
    () => ({ ...formFromInitiative(null), initiative_type: 'move' }));
  const [assetJob, setAssetJob] = useState<ImportJobOut | null>(null);
  const [crates, setCrates] = useState<CratesValue | null>(null);
  const [trucks, setTrucks] = useState<TrucksValue | null>(null);
  const [lookups, setLookups] = useState<MoveSetupLookups>(EMPTY_LOOKUPS);
  const [finished, setFinished] = useState(false);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  // skipped, and not edited since: revisiting must not save (include) it again
  const [skipped, setSkipped] = useState<ReadonlySet<SkippableSection>>(() => new Set());
  const include = useCallback((section: SkippableSection) => setSkipped((prev) => {
    if (!prev.has(section)) return prev;
    const nextSet = new Set(prev);
    nextSet.delete(section);
    return nextSet;
  }), []);

  useEffect(() => {
    const put = <K extends keyof MoveSetupLookups>(key: K) => (value: MoveSetupLookups[K]) =>
      setLookups((l) => ({ ...l, [key]: value }));
    void listInitiativeStatuses().then(put('statuses')).catch(() => {});
    void listInitiativeTypes().then(put('types')).catch(() => {});
    void listInitiativeSubTypes().then(put('subTypes')).catch(() => {});
    void listShippingTypes().then(put('shippingTypes')).catch(() => {});
    void listSites().then(put('sites')).catch(() => {});
    void listClients().then(put('clients')).catch(() => {});
    void listPartners().then(put('partners')).catch(() => {});
    void listContainerTypes().then(put('containerTypes')).catch(() => {});
  }, []);

  const origin = lookups.sites.find((s) => s.id === form.origin_site_id) ?? null;
  const destination = lookups.sites.find((s) => s.id === form.destination_site_id) ?? null;
  // the crate/truck steps open prefilled from the site codes, once; Back keeps edits
  useEffect(() => {
    if (step === 2 && crates === null) setCrates(initialCrates(origin, destination));
    if (step === 3 && trucks === null) setTrucks(initialTrucks(origin, destination));
  }, [step]);   // eslint-disable-line react-hooks/exhaustive-deps

  const done = finished || draft?.status === 'completed';
  const live = draft !== null && !done;
  // queued or running: the worker holds the draft (the API refuses a DELETE)
  const creating = draft?.status === 'queued' || draft?.status === 'running';
  const deletableId = live && !creating ? draft.id : null;
  const liveId = useRef<string | null>(null);   // what the unmount cleanup may delete
  useEffect(() => { liveId.current = deletableId; }, [deletableId]);
  const discarded = useRef(false);             // Discard already deleted it
  useEffect(() => () => {
    if (liveId.current && !discarded.current) {
      void deleteMoveSetup(liveId.current, { keepalive: true }).catch(() => undefined);
    }
  }, []);
  useLeaveGuard(live, setLeaveTo);

  const leave = async () => {
    if (leaveTo === null || draft === null) return;
    if (creating) { navigate(leaveTo); return; }   // it finishes without us; nothing to delete
    setDiscarding(true);
    discarded.current = true;                  // the unmount cleanup must not delete twice
    await deleteMoveSetup(draft.id).catch(() => undefined);
    navigate(leaveTo);
  };

  const back = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);
  const next = useCallback(() => setStep((s) => Math.min(MOVE_SETUP_STEPS.length - 1, s + 1)), []);
  const finish = useCallback(() => setFinished(true), []);
  const skip = (section: SkippableSection) => async () => {
    if (!draft) return;
    const saved = await patchMoveSetup(draft.id, { skip: [section] });
    setDraft(saved);
    setSkipped((prev) => new Set(prev).add(section));
    if (section === 'assets') setAssetJob(null);
    next();
  };

  const meta = MOVE_SETUP_STEPS[step]!;
  return (
    <div className="portal-page">
      <WizardHeader steps={MOVE_SETUP_STEPS} current={step} title={meta.title}
                    description={meta.description} allDone={finished} />
      <div className="wiz-body">
        {step === 0 && (
          <MoveStep form={form} setForm={setForm} lookups={lookups} draft={draft}
                    onDraft={setDraft} onNext={next} />
        )}
        {step === 1 && draft && (
          <AssetsStep draft={draft} job={assetJob} setJob={setAssetJob}
                      onBack={back} onSkip={skip('assets')} onNext={next} />
        )}
        {step === 2 && draft && crates && (
          <CratesStep draft={draft} value={crates}
                      setValue={(v) => { include('crates'); setCrates(v); }}
                      skipped={skipped.has('crates')}
                      containerTypes={lookups.containerTypes} onDraft={setDraft}
                      onBack={back} onSkip={skip('crates')} onNext={next} />
        )}
        {step === 3 && draft && trucks && (
          <TrucksStep draft={draft} value={trucks}
                      setValue={(v) => { include('trucks'); setTrucks(v); }}
                      skipped={skipped.has('trucks')} origin={origin} destination={destination} onDraft={setDraft}
                      onBack={back} onSkip={skip('trucks')} onNext={next} />
        )}
        {step === 4 && draft && (
          <ReviewStep draft={draft} onDraft={setDraft} form={form} lookups={lookups}
                      assetJob={assetJob} onBack={back} onFinished={finish} />
        )}
      </div>
      {leaveTo !== null && (
        <DiscardDialog mode={creating ? 'creating' : 'discard'} busy={discarding}
                       onConfirm={() => void leave()} onCancel={() => setLeaveTo(null)} />
      )}
    </div>
  );
}
