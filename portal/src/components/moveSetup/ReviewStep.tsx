/** Step 5 — review and create. A summary of every step ("Skipped" for a
 *  skipped one), then Create move: queue the draft, poll it every 1.5 s
 *  ("Creating… N of M"), and show the finish screen. A failure shows its
 *  reason as sentences and the draft stays editable (Back, then Create again). */
import { useEffect, useRef, useState } from 'react';

import {
  ApiError, createMoveFromSetup, getMoveSetup, type ImportJobOut, type MoveSetupDraft,
} from '../../lib/api';
import { assignTags, summaryText, type TagCounts } from '../../lib/bulkContainers';
import { TAG_TYPES, type TagKey } from '../../labels/tagTypes';
import type { InitiativeFormState } from '../../lib/initiatives';
import {
  MOVE_SETUP_ERRORS, moveSetupError, moveSummaryRows, setupReasons, type MoveSetupLookups,
} from '../../lib/moveSetup';
import { CRATE_MAX, generateNames, TRUCK_MAX } from '../../lib/namingConvention';
import DataTable from '../DataTable';
import WizardFooter from '../common/WizardFooter';
import ImportReport from '../imports/ImportReport';
import MoveSetupFinish from './MoveSetupFinish';

const POLL_MS = 1500;
const LIST_LIMIT = 100;
const NO_FIXES = new Set<string>();

interface Props {
  draft: MoveSetupDraft;
  onDraft: (draft: MoveSetupDraft) => void;
  form: InitiativeFormState;
  lookups: MoveSetupLookups;
  assetJob: ImportJobOut | null;
  onBack: () => void;
  onFinished: () => void;
}

/** The names a step will create, the first 100 until "Show all". */
function NamesTable({ label, names, tags }: { label: string; names: string[]; tags?: (TagKey | null)[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? names : names.slice(0, LIST_LIMIT);
  return (
    <>
      <DataTable ariaLabel={label}
                 columns={[{ key: 'name', label: 'Name', mono: true },
                           ...(tags ? [{ key: 'tag', label: 'Label tag' }] : [])]}
                 rows={shown.map((name, i) => {
                   const tag = tags?.[i];
                   return { key: name, cells: [name, ...(tags ? [tag ? TAG_TYPES[tag].label : '—'] : [])] };
                 })} />
      {names.length > shown.length && (
        <div className="bulk-actions">
          <button className="mini-btn" type="button" onClick={() => setAll(true)}>Show all {names.length}</button>
        </div>
      )}
    </>
  );
}

export default function ReviewStep({ draft, onDraft, form, lookups, assetJob, onBack, onFinished }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reasons, setReasons] = useState<string[]>([]);
  const creating = useRef(false);        // a Create was sent: the mount refresh is stale
  const running = draft.status === 'queued' || draft.status === 'running';

  // the draft as the server holds it now (the live-saved crate/truck edits included)
  useEffect(() => {
    let alive = true;
    void getMoveSetup(draft.id).then((fresh) => {
      if (alive && !creating.current) onDraft(fresh);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [draft.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!running) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await getMoveSetup(draft.id);
        if (stopped) return;
        onDraft(next);
        if (next.status !== 'queued' && next.status !== 'running') return;
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError) { setError(moveSetupError(err)); return; }
        // a network blip: keep polling
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [running, draft.id, onDraft]);

  useEffect(() => { if (draft.status === 'completed') onFinished(); }, [draft.status, onFinished]);

  if (draft.status === 'completed') return <MoveSetupFinish draft={draft} moveName={form.name.trim()} />;

  const create = async () => {
    creating.current = true;
    setBusy(true);
    setError('');
    setReasons([]);
    try {
      onDraft(await createMoveFromSetup(draft.id));
    } catch (err) {
      setError(moveSetupError(err));
      setReasons(setupReasons(err));
    } finally {
      setBusy(false);
    }
  };

  const payload = draft.payload;
  const crates = payload?.crates ?? null;
  const trucks = payload?.trucks ?? null;
  const crateNames = crates ? generateNames(crates.convention, crates.count, crates.start, CRATE_MAX).names : [];
  const truckNames = trucks ? generateNames(trucks.convention, trucks.count, trucks.start, TRUCK_MAX).names : [];
  const crateTags = (crates?.tags ?? {}) as TagCounts;
  const typeLabel = lookups.containerTypes.find((t) => t.key === crates?.container_type)?.label
    ?? crates?.container_type ?? '';
  const failedReasons = draft.status === 'failed' ? draft.results?.reasons ?? [] : [];
  const progress = draft.total_rows > 0
    ? `Creating… ${draft.processed_rows} of ${draft.total_rows}` : 'Creating the move…';

  return (
    <>
      <section className="bulk-section">
        <p className="eyebrow-sm">The move</p>
        <DataTable ariaLabel="The move" columns={[{ key: 'field', label: 'Field' }, { key: 'value', label: 'Value' }]}
                   rows={moveSummaryRows(form, lookups).map(([k, v]) => ({ key: k, cells: [k, v] }))} />
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">From-To assets</p>
        {!payload?.assets ? <p className="page-hint">Skipped</p>
          : assetJob?.results
            ? <ImportReport job={assetJob} fixedTexts={NO_FIXES} onFix={() => undefined}
                            canAddModels={false} canChangeModels={false} readOnly />
            : <p className="page-hint">{payload.assets.filename}</p>}
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Crates</p>
        {!crates ? <p className="page-hint">Skipped</p>
          : crateNames.length === 0 ? <p className="page-hint">No crates</p>
          : (<>
              <p className="page-hint">
                {summaryText(crateNames.length, crateTags, 'crate').replace(
                  /^(\d+ crates?)/, `$1 · ${typeLabel || 'No crate type'}`)}
              </p>
              <NamesTable label="Crates" names={crateNames} tags={assignTags(crateNames.length, crateTags)} />
            </>)}
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Trucks</p>
        {!trucks ? <p className="page-hint">Skipped</p>
          : truckNames.length === 0 ? <p className="page-hint">No trucks</p>
          : <NamesTable label="Trucks" names={truckNames} />}
      </section>

      {draft.status === 'failed' && (
        <div className="dir-empty">
          <b>The move was not created</b>
          {MOVE_SETUP_ERRORS[draft.error ?? ''] ?? MOVE_SETUP_ERRORS.worker_error}
          {failedReasons.length > 0 && (
            <ul className="ms-reasons">{failedReasons.map((r) => <li key={r}>{r}</li>)}</ul>
          )}
        </div>
      )}
      {reasons.length > 0 && (
        <div>
          <p className="pf-error">{error}</p>
          <ul className="ms-reasons">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
      {running && <p className="set-note">{progress}</p>}

      <WizardFooter onBack={running ? undefined : onBack} onNext={() => void create()}
                    nextLabel={running ? 'Creating…' : 'Create move'} busy={busy || running}
                    error={reasons.length > 0 ? '' : error} />
    </>
  );
}
