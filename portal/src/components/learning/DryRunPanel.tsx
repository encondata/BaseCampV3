/**
 * The dry run on the Assignment rules page: pick an initiative and see what
 * the rules would assign right now — four summary tiles, then one row per
 * worker (what they will get and why, what was skipped, who has no email).
 * Nothing is sent by looking. Download summary writes the rows as CSV;
 * "Assign and schedule invites" runs the same call with apply=true and is
 * offered only to managers with learning:add (the API refuses it otherwise).
 *
 * With `initiativeId` the panel is pinned to that initiative (an initiative's
 * Learning tab): no picker, it runs on open, and `onApplied` tells the host
 * that assignments changed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listInitiatives, type InitiativeItem } from '../../lib/api';
import {
  dryRunInitiative, type AssignSummary, type AssignSummaryRow,
} from '../../lib/learning';
import { apiErrorText } from '../../lib/learningDoc';
import { exportCsv } from '../../lib/listTools';
import { useToast } from '../../lib/notificationsContext';
import { naturalCompare } from '../../lib/sites';
import ComboBox from '../ComboBox';
import { reasonText } from './dryRunCopy';
import LearningList, { type LearningColumn } from './LearningList';
import { useLearningAccess } from './useLearningAccess';

const COLUMNS = {
  worker: { key: 'worker', label: 'Worker', width: '1.2fr', default: true, min: 150 },
  willGet: { key: 'willGet', label: 'Will get', width: '2fr', default: true, min: 200 },
  why: { key: 'why', label: 'Why', width: '1.6fr', default: true, min: 160 },
  skipped: { key: 'skipped', label: 'Skipped', width: '1.8fr', default: true, min: 180 },
};
export { COLUMNS as DRY_RUN_COLUMNS };

const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;
const unique = (list: string[]) => Array.from(new Set(list));
const skippedText = (r: AssignSummaryRow) => r.skipped.map((s) => `${s.title}: ${reasonText(s.reason)}`);
const whyText = (r: AssignSummaryRow) => unique(r.why.map(reasonText));

type Phase = 'idle' | 'running' | 'ready' | 'failed';

export default function DryRunPanel({ initiativeId: pinned, onApplied }: {
  initiativeId?: string;
  onApplied?: () => void;
} = {}) {
  const toast = useToast();
  const canApply = useLearningAccess()('add');
  const [initiatives, setInitiatives] = useState<InitiativeItem[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [picked, setInitiativeId] = useState('');
  const initiativeId = pinned ?? picked;
  const [phase, setPhase] = useState<Phase>('idle');
  const [summary, setSummary] = useState<AssignSummary | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState('');
  const [error, setError] = useState('');
  // only the newest request may write its result
  const seq = useRef(0);

  const loadInitiatives = useCallback(() => {
    setListFailed(false);
    listInitiatives().then(setInitiatives).catch(() => { setListFailed(true); setInitiatives([]); });
  }, []);
  useEffect(() => { if (pinned === undefined) loadInitiatives(); }, [loadInitiatives, pinned]);

  const options = useMemo(() => (initiatives ?? []).filter((i) => !i.archived_at)
    .sort((a, b) => naturalCompare(a.name, b.name))
    .map((i) => ({ value: i.id, label: i.name, sub: i.code ?? null })), [initiatives]);

  const run = (id: string) => {
    const mine = ++seq.current;
    setPhase('running');
    setSummary(null);
    setApplied('');
    setError('');
    dryRunInitiative(id, false)
      .then((s) => { if (seq.current === mine) { setSummary(s); setPhase('ready'); } })
      .catch(() => { if (seq.current === mine) setPhase('failed'); });
  };

  // pinned to an initiative: check it as soon as the panel opens
  useEffect(() => { if (pinned !== undefined) run(pinned); }, [pinned]);   // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (id: string) => {
    setInitiativeId(id);
    if (id) run(id);
    else { seq.current += 1; setPhase('idle'); setSummary(null); setApplied(''); setError(''); }
  };

  const apply = async () => {
    if (!initiativeId) return;
    const mine = ++seq.current;
    setApplying(true);
    setError('');
    try {
      const done = await dryRunInitiative(initiativeId, true);
      if (seq.current !== mine) return;
      const people = done.rows.filter((r) => r.will_get.length > 0).length;
      const text = `Assigned ${plural(done.totals.to_assign, 'document')} to ${plural(people, 'worker')}.`;
      setApplied(text);
      toast(text);
      onApplied?.();
      // the preview above is the state before the assignment: check again
      try {
        const fresh = await dryRunInitiative(initiativeId, false);
        if (seq.current === mine) setSummary(fresh);
      } catch {
        if (seq.current === mine) { setSummary(null); setPhase('failed'); }
      }
    } catch (e) {
      if (seq.current === mine) setError(apiErrorText(e));
    } finally {
      setApplying(false);
    }
  };

  const download = () => {
    if (!summary) return;
    exportCsv<AssignSummaryRow>('learning-dry-run', [
      ['Worker', (r) => r.name],
      ['Will get', (r) => r.will_get.join('; ')],
      ['Why', (r) => whyText(r).join('; ')],
      ['Skipped', (r) => skippedText(r).join('; ')],
      ['No email', (r) => (r.no_email ? 'Yes' : 'No')],
    ], summary.rows);
  };

  const columns: LearningColumn<AssignSummaryRow>[] = [
    { def: COLUMNS.worker, cell: (r) => <span className="cell-top cell-line" title={r.name}>{r.name}</span> },
    {
      def: COLUMNS.willGet,
      cell: (r) => {
        const text = r.will_get.length ? r.will_get.join(', ') : 'Nothing new';
        return <span className="cell-sub cell-line" title={text}>{text}</span>;
      },
    },
    {
      def: COLUMNS.why,
      cell: (r) => {
        const text = r.will_get.length ? whyText(r).join(' · ') : '—';
        return <span className="cell-sub cell-line" title={text}>{text}</span>;
      },
    },
    {
      def: COLUMNS.skipped,
      cell: (r) => {
        const text = skippedText(r).join('; ');
        return (
          <>
            <span className="cell-sub cell-line" title={text}>{text || 'None'}</span>
            {r.no_email && <span className="chip c-amber">No email: print code</span>}
          </>
        );
      },
    },
  ];

  const totals = summary?.totals;
  const tiles: [string, number | undefined, string][] = [
    ['Workers checked', totals?.checked, ''],
    ['Documents to assign', totals?.to_assign, 'lrn-blue'],
    ['Already valid, skipped', totals?.skipped, 'lrn-green'],
    ['No email on file', totals?.no_email, 'lrn-amber'],
  ];
  const nothingToAssign = summary !== null && summary.totals.to_assign === 0;

  return (
    <section className="lrn-card lrn-dryrun" id="lrn-dryrun" aria-label="Dry run">
      <div className="lrn-section-head">
        <p className="lrn-kicker">Dry run</p>
        <span className="lrn-hint">Nothing is sent until you confirm</span>
      </div>
      <div className="lrn-dryrun-pick">
        {pinned === undefined && (
          <>
            <label htmlFor="lrn-dryrun-initiative" className="lrn-lbl">Initiative</label>
            <div className="lrn-dryrun-combo">
              <ComboBox options={options} value={initiativeId} onChange={pick} clearable
                        inputId="lrn-dryrun-initiative" ariaLabel="Initiative to check"
                        placeholder={initiatives === null ? 'Loading…' : 'Type to search initiatives…'} />
            </div>
          </>
        )}
        {initiativeId && phase !== 'running' && (
          <button type="button" className="mini-btn" onClick={() => run(initiativeId)} disabled={applying}>
            Run again
          </button>
        )}
      </div>
      {listFailed && (
        <p className="pf-error" role="alert">
          Couldn’t load the initiatives.{' '}
          <button type="button" className="mini-btn" onClick={loadInitiatives}>Try again</button>
        </p>
      )}
      {!initiativeId && !listFailed && pinned === undefined && (
        <p className="lrn-hint">Pick an initiative to see who would get what, and why, under the rules above.</p>
      )}
      {phase === 'running' && <p className="page-hint">Checking the rules…</p>}
      {phase === 'failed' && (
        <p className="pf-error" role="alert">
          Couldn’t run the dry run.{' '}
          <button type="button" className="mini-btn" onClick={() => run(initiativeId)}>Try again</button>
        </p>
      )}

      {summary && (
        <>
          <div className="lrn-tiles" role="group" aria-label="Dry run totals">
            {tiles.map(([label, value, tone]) => (
              <div key={label} className="lrn-tile">
                <div className={`lrn-tile-v ${tone}`}>{(value ?? 0).toLocaleString()}</div>
                <div className="lrn-tile-k">{label}</div>
              </div>
            ))}
          </div>
          {applied && <p className="lrn-done" role="status">{applied}</p>}
          <LearningList columns={columns} rows={summary.rows} rowKey={(r) => r.person_id}
                        ariaLabel="Dry run results"
                        empty={<><b>Nobody needs anything</b>Everyone on this initiative is already covered.</>} />
          <div className="lrn-dryrun-foot">
            <button type="button" className="mini-btn" onClick={download} disabled={summary.rows.length === 0}>
              Download summary
            </button>
            {canApply && (
              <button type="button" className="btn-solid" onClick={() => void apply()}
                      disabled={applying || applied !== '' || nothingToAssign}>
                {applying ? 'Assigning…' : 'Assign and schedule invites'}
              </button>
            )}
          </div>
        </>
      )}
      {error && <p className="pf-error" role="alert">{error}</p>}
    </section>
  );
}
