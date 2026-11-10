/** The editor's test bar: type a value, pick what to test against (the
 *  test set, or a move's assets), Run. The current flow is sent as it is
 *  on the page, saved or not. The result line and the trace show under the
 *  controls, and `onRun` hands the run up so the canvas lights its path.
 *  Any edit to the flow clears the result and the highlight, so a stale
 *  path is never lit on a changed flow. Moves load the first time "A move"
 *  is chosen. */

import { useEffect, useMemo, useRef, useState } from 'react';

import ComboBox, { type ComboOption } from '../ComboBox';
import {
  ApiError, listInitiatives, testRunMatchingFlow,
  type MatchingPlace, type MatchingRun, type MatchingTraceStep,
} from '../../lib/api';
import { FIELDS, FOUND_ACTIONS, nodeTitle, type Flow } from '../../lib/matchingRules';
import { naturalCompare } from '../../lib/naturalSort';

const STOP_REASONS: Record<string, string> = {
  no_scan_input: 'the flow needs exactly one Scan input',
  unwired: "the output it took isn't wired",
  two_wires: 'an output is wired to two steps',
  loop: 'the flow loops back to a step it already ran',
  bad_settings: "this step's settings aren't filled in",
  found_without_match: 'Found was reached without a Match',
};

const ERROR_COPY: Record<string, string> = {
  initiative_not_found: 'That move no longer exists.',
  bad_initiative: 'Pick a move, not a project or event.',
  value_required: 'Enter a value to test.',
};

type Against = 'test_set' | 'move';

export default function TestBar({ place, flow, onRun }: {
  place: MatchingPlace;
  flow: Flow;
  onRun: (run: MatchingRun | null) => void;
}) {
  const [value, setValue] = useState('');
  const [against, setAgainst] = useState<Against>('test_set');
  const [moveId, setMoveId] = useState('');
  const [moves, setMoves] = useState<ComboOption[] | null>(null);
  const [run, setRun] = useState<MatchingRun | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Bumped by every run and every flow change, so a late answer for an older flow is dropped.
  const seq = useRef(0);
  const lastFlow = useRef(flow);
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  useEffect(() => {
    if (lastFlow.current === flow) return;
    lastFlow.current = flow;
    seq.current += 1;
    setRun(null);
    setError('');
    setBusy(false);
    onRunRef.current(null);
  }, [flow]);

  useEffect(() => {
    if (against !== 'move' || moves) return;
    let live = true;
    listInitiatives()
      .then((items) => {
        if (!live) return;
        setMoves(items
          .filter((i) => i.initiative_type === 'move')
          .sort((a, b) => naturalCompare(a.name, b.name))
          .map((i) => ({ value: i.id, label: i.name })));
      })
      .catch(() => { if (live) setError('The moves could not be loaded. Try again.'); });
    return () => { live = false; };
  }, [against, moves]);

  const canRun = value.trim() !== '' && (against === 'test_set' || moveId !== '') && !busy;

  const doRun = async () => {
    const mine = ++seq.current;
    setBusy(true);
    setError('');
    try {
      const result = await testRunMatchingFlow({
        place, flow, value, against,
        ...(against === 'move' ? { initiative_id: moveId } : {}),
      });
      if (mine !== seq.current) return;
      setRun(result);
      onRun(result);
    } catch (err) {
      if (mine !== seq.current) return;
      setRun(null);
      onRun(null);
      setError(err instanceof ApiError && ERROR_COPY[err.code] ? ERROR_COPY[err.code] : 'The test run failed. Try again.');
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  };

  const nodeById = useMemo(() => new Map(flow.nodes.map((n) => [n.id, n])), [flow]);
  const titleOf = (id: string | null): string => {
    const n = id ? nodeById.get(id) : undefined;
    return n ? nodeTitle(n) : 'a step';
  };

  const summary = (r: MatchingRun): string => {
    if (r.outcome === 'found') {
      const field = FIELDS.find((f) => f.key === r.field)?.label ?? r.field ?? '';
      const action = FOUND_ACTIONS.find((a) => a.key === r.action)?.label ?? r.action ?? '';
      const a = r.asset;
      return `Found by ${field}: ${a?.name ?? ''} (asset tag ${a?.asset_tag ?? ''}) · ${action}`;
    }
    if (r.outcome === 'not_found') return `Not found · ${r.message ?? ''}`;
    return `Stopped at ${titleOf(r.end_node_id)}: ${STOP_REASONS[r.stop_reason ?? ''] ?? r.stop_reason ?? ''}`;
  };

  const traceLine = (s: MatchingTraceStep, i: number): string => {
    let line = `${i + 1}. ${titleOf(s.node_id)}  "${s.value_in}" → "${s.value_out ?? ''}"  ${s.output ?? ''}`;
    if (s.kind === 'match' && s.hits) {
      const tags = s.hits.map((h) => h.asset_tag);
      line += `  ${tags.length} ${tags.length === 1 ? 'hit' : 'hits'}: ${tags.join(', ')}`;
      if (tags.length >= 2) line += ` · took ${tags[0]}`;
    }
    return line;
  };

  return (
    <div className="mr-test pf-form">
      <div className="mr-test-controls">
        <div>
          <label htmlFor="mr-test-value">Value to test</label>
          <input id="mr-test-value" value={value} autoComplete="off"
                 onChange={(e) => setValue(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter' && canRun) void doRun(); }} />
        </div>
        <div>
          <label id="mr-test-against">Test against</label>
          <div className="segmented" role="group" aria-labelledby="mr-test-against">
            {([['test_set', 'Test set'], ['move', 'A move']] as const).map(([key, label]) => (
              <button key={key} type="button" className={against === key ? 'on' : ''}
                      aria-pressed={against === key} onClick={() => setAgainst(key)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {against === 'move' && (
          <div>
            <label htmlFor="mr-test-move">Move</label>
            <ComboBox inputId="mr-test-move" options={moves ?? []} value={moveId} portal
                      onChange={setMoveId} />
          </div>
        )}
        <button type="button" className="btn-solid" disabled={!canRun} onClick={() => void doRun()}>Run</button>
      </div>
      {error && <p className="pf-error" role="alert">{error}</p>}
      {run && (
        <>
          <p className={`mr-test-result ${run.outcome === 'found' ? 'mr-pass' : run.outcome === 'stopped' ? 'mr-fail' : ''}`}>
            {summary(run)}
          </p>
          <ol className="mr-scroll mr-trace">
            {run.trace.map((s, i) => <li key={`${s.node_id}-${i}`}>{traceLine(s, i)}</li>)}
          </ol>
        </>
      )}
    </div>
  );
}
