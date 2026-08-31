/** Executions tab — per-fire status-rule execution log. Read-only: a
 *  rule-filtered, paged history of every time the scan matcher evaluated
 *  a rule, whether its conditions matched, which actions fired (or were
 *  skipped), and any error. Ordering and paging are server-driven — this
 *  tab renders whatever page `listStatusRuleExecutions` returns. */

import { useEffect, useState } from 'react';

import {
  ApiError, listStatusRuleExecutions, listStatusRules,
  type StatusRule, type StatusRuleExecution,
} from '../../lib/api';

const PAGE = 100;

// Time | Rule | Scan | Result | Actions | Duration
const GRID = '160px 1.2fr 1.1fr 150px 1fr 90px';

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

export default function ExecutionsTab({ onCount }: {
  onCount: (n: number | null) => void;
}) {
  const [rules, setRules] = useState<StatusRule[] | null>(null);
  const [rows, setRows] = useState<StatusRuleExecution[]>([]);
  const [filter, setFilter] = useState('');
  const [done, setDone] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [r, execs] = await Promise.all([
          listStatusRules(), listStatusRuleExecutions({ limit: PAGE }),
        ]);
        setRules(r);
        setRows(execs);
        setDone(execs.length < PAGE);
        setError('');
        onCount(execs.length);
      } catch (err) {
        setError(msgFor(err));
        onCount(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilter = async (value: string) => {
    setFilter(value);
    try {
      const execs = await listStatusRuleExecutions({ ruleId: value || undefined, limit: PAGE });
      setRows(execs);
      setDone(execs.length < PAGE);
      setError('');
      onCount(execs.length);
    } catch (err) {
      setError(msgFor(err));
      onCount(null);
    }
  };

  const loadMore = async () => {
    try {
      const execs = await listStatusRuleExecutions({
        ruleId: filter || undefined, limit: PAGE, offset: rows.length,
      });
      setRows((prev) => [...prev, ...execs]);
      setDone(execs.length < PAGE);
      setError('');
      onCount(rows.length + execs.length);
    } catch (err) {
      setError(msgFor(err));
    }
  };

  return (
    <>
      <div className="dir-toolbar">
        <div className="toolbar-right">
          <select aria-label="Filter by rule" value={filter}
                  onChange={(e) => void applyFilter(e.target.value)}>
            <option value="">All rules</option>
            {rules?.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <span className="result-count">{rows.length} executions</span>
        </div>
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>Cannot load executions</b>{error}
        </div>
      )}

      {rules && (
        <div className="dir-list">
          <div className="list-head" style={{ gridTemplateColumns: GRID }}>
            <span className="col-head">Time</span>
            <span className="col-head">Rule</span>
            <span className="col-head">Scan</span>
            <span className="col-head">Result</span>
            <span className="col-head">Actions</span>
            <span className="col-head">Duration</span>
          </div>

          {rows.length === 0 && (
            <div className="dir-empty">
              <b>No executions yet</b>Nothing has run yet.
            </div>
          )}

          {rows.map((exec) => {
            const result = resultChip(exec);
            const actionsTitle = JSON.stringify(exec.actions_applied, null, 2);
            return (
              <div key={exec.id} className="dir-row">
                <div className="row-main" style={{ gridTemplateColumns: GRID, cursor: 'default' }}>
                  <div className="cell mono">{new Date(exec.executed_at).toLocaleString()}</div>
                  <div className="cell">{exec.rule_name}</div>
                  <div className="cell">
                    {exec.error != null ? '—' : (
                      <>
                        <span className="cell-top mono">{exec.scanned_value ?? '—'}</span>
                        <span className="cell-sub">{exec.scan_status ?? '—'}</span>
                      </>
                    )}
                  </div>
                  <div className="cell">
                    <span className={result.cls}>{result.label}</span>
                  </div>
                  <div className="cell" title={actionsTitle}>
                    {actionsSummary(exec.actions_applied)}
                  </div>
                  <div className="cell mono">{exec.duration_ms}ms</div>
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
          <button type="button" className="mini-btn" onClick={() => void loadMore()}>
            Load more
          </button>
        </div>
      )}
    </>
  );
}
