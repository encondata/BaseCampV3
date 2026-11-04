/** Executions tab — per-fire status-rule execution log. Read-only: a
 *  rule-filtered, paged history of every time the scan matcher evaluated
 *  a rule, whether its conditions matched, which actions fired (or were
 *  skipped, and why), and any error. Ordering and paging are server-driven —
 *  this tab renders whatever page `listStatusRuleExecutions` returns.
 *
 *  The rule filter (the house ComboBox) is the page's to hold, since the page
 *  keeps it in the URL: `ruleId` is the rule listed ('' = every rule's) and
 *  a pick is handed to `onRuleChange`. The first page is fetched again
 *  whenever `ruleId` changes, a pick or a link moving the URL. */

import { useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  ApiError, listStatusRuleExecutions, listStatusRules,
  type StatusRule, type StatusRuleExecution,
} from '../../lib/api';
import { ColHead, listGridStyle, listScale, titleFor, type ColumnDef } from '../../lib/listTools';
import ComboBox, { type ComboOption } from '../ComboBox';
import '../../styles/status-rules.css';

const PAGE = 100;

// No column registry pre-migration (hand-written header spans) — this
// local COLUMNS mirrors them (recipe R1). Read-only, unsortable list —
// headers render as plain ColHead spans (no onToggleSort).
// Fit: default columns + trailing ≤ LIST_FIT.page (1172px — .portal-page at a
// 1512px window, nav expanded — ExecutionsTab sits directly in .portal-page,
// under the tab bar, with no extra card).
const COLUMNS: ColumnDef[] = [
  { key: 'time', label: 'Time', width: '160px', default: true },
  { key: 'rule', label: 'Rule', width: '1.2fr', default: true, min: 140 },
  { key: 'scan', label: 'Scan', width: '1.1fr', default: true },
  { key: 'result', label: 'Result', width: '150px', default: true },
  { key: 'actions', label: 'Actions', width: '1fr', default: true },
  { key: 'duration', label: 'Duration', width: '90px', default: true },
];

const msgFor = (err: unknown): string =>
  (err instanceof ApiError ? `Request failed (${err.code}).` : "Couldn't load executions.");

function resultChip(exec: StatusRuleExecution): { cls: string; label: string } {
  if (exec.error != null) return { cls: 'chip c-red', label: 'Error' };
  if (exec.conditions_met) return { cls: 'chip c-green', label: 'Executed' };
  return { cls: 'chip', label: 'Conditions not met' };
}

function actionsSummary(applied: StatusRuleExecution['actions_applied']): string {
  const appliedCount = applied.filter((a) => a.applied).length;
  const skipped = applied.length - appliedCount;
  return skipped > 0 ? `${appliedCount} applied · skipped ${skipped}` : `${appliedCount} applied`;
}

/** Why an action was not applied, for the reasons that have words of their own; any other
 *  reason shows as the engine's code. */
const REASON_LABELS = new Map([
  ['notified_within_hour', 'Notified within the hour'],
]);

/** The actions cell's tooltip: what the scan matched and how, then what each action did, as
 *  the engine recorded them, with the reasons that have words of their own in those words. */
function actionsTooltip(exec: StatusRuleExecution): string {
  return JSON.stringify({
    match: exec.match,
    actions: exec.actions_applied.map((a) => (a.reason === undefined
      ? a : { ...a, reason: REASON_LABELS.get(a.reason) ?? a.reason })),
  }, null, 2);
}

export default function ExecutionsTab({ onCount, ruleId, onRuleChange }: {
  onCount: (n: number | null) => void;
  /** The rule whose executions are listed; '' lists every rule's. */
  ruleId: string;
  onRuleChange: (ruleId: string) => void;
}) {
  const { preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const [rules, setRules] = useState<StatusRule[] | null>(null);
  const [rows, setRows] = useState<StatusRuleExecution[]>([]);
  const [done, setDone] = useState(true);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped on every first-page load (a new rule included) / load-more so a
  // slow, superseded response can be detected and ignored (see ProcessLogs'
  // `alive` flag for the effect-cleanup equivalent of this guard).
  const seq = useRef(0);

  // The first page of the chosen rule's executions, again whenever the rule changes. The rules
  // (the filter's options) come once, with the first page.
  useEffect(() => {
    const mySeq = ++seq.current;
    (async () => {
      try {
        const [r, execs] = await Promise.all([
          rules ?? listStatusRules(),
          listStatusRuleExecutions({ ruleId: ruleId || undefined, limit: PAGE }),
        ]);
        if (mySeq !== seq.current) return;
        setRules(r);
        setRows(execs);
        setDone(execs.length < PAGE);
        setError('');
        onCount(execs.length);
      } catch (err) {
        if (mySeq !== seq.current) return;
        setError(msgFor(err));
        onCount(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleId]);

  const ruleOptions = useMemo<ComboOption[]>(() => [
    { value: '', label: 'All rules' },
    ...(rules ?? []).map((r) => ({ value: r.id, label: r.name })),
  ], [rules]);

  const grid = listGridStyle(COLUMNS, [], undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    const mySeq = ++seq.current;
    try {
      const execs = await listStatusRuleExecutions({
        ruleId: ruleId || undefined, limit: PAGE, offset: rows.length,
      });
      if (mySeq !== seq.current) return;
      setRows((prev) => [...prev, ...execs]);
      setDone(execs.length < PAGE);
      setError('');
      onCount(rows.length + execs.length);
    } catch (err) {
      if (mySeq !== seq.current) return;
      setError(msgFor(err));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <div className="dir-toolbar">
        <div className="toolbar-right">
          {rules && (
            <div className="exec-rule-filter">
              <ComboBox ariaLabel="Filter by rule" options={ruleOptions} value={ruleId}
                        onChange={onRuleChange} />
            </div>
          )}
          <span className="result-count">{rows.length} executions</span>
        </div>
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>Cannot load executions</b>{error}
        </div>
      )}

      {rules && (
        <div className="dir-list list-scroll">
          <div className="list-head" style={rowStyle}>
            {COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
          </div>

          {rows.length === 0 && (
            <div className="dir-empty">
              <b>No executions yet</b>Nothing has run yet.
            </div>
          )}

          {rows.map((exec) => {
            const result = resultChip(exec);
            const actionsTitle = actionsTooltip(exec);
            const time = new Date(exec.executed_at).toLocaleString();
            const scanValue = exec.scanned_value ?? '—';
            const scanStatus = exec.scan_status ?? '—';
            const actionsText = actionsSummary(exec.actions_applied);
            const duration = `${exec.duration_ms}ms`;
            return (
              <div key={exec.id} className="dir-row" style={{ minWidth: rowStyle.minWidth }}>
                <div className="row-main" style={{ ...rowStyle, cursor: 'default' }}>
                  <div className="cell mono cell-line" title={titleFor(time)}>{time}</div>
                  <div className="cell cell-line" title={titleFor(exec.rule_name)}>{exec.rule_name}</div>
                  <div className="cell">
                    {exec.error != null ? '—' : (
                      <>
                        <span className="cell-top mono cell-line" title={titleFor(scanValue)}>{scanValue}</span>
                        <span className="cell-sub cell-line" title={titleFor(scanStatus)}>{scanStatus}</span>
                      </>
                    )}
                  </div>
                  <div className="cell">
                    <span className={result.cls}>{result.label}</span>
                  </div>
                  <div className="cell cell-line" title={actionsTitle}>
                    {actionsText}
                  </div>
                  <div className="cell mono cell-line" title={titleFor(duration)}>{duration}</div>
                </div>
                {exec.error != null && (
                  <div className="cell-sub" style={{ padding: '0 20px 10px' }}>{exec.error}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {rules && !done && (
        <div style={{ marginTop: 12 }}>
          <button type="button" className="mini-btn" disabled={loadingMore}
                  onClick={() => void loadMore()}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </>
  );
}
