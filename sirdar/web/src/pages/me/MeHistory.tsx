/** /me › History — what the signed-in account did (and what was done to
 *  it), newest first, with client-side Action / Record type filters. */
import { useEffect, useMemo, useState } from 'react';

import ComboBox from '@portal/components/ComboBox';
import DataTable from '@portal/components/DataTable';
import { getMyActivityRequest, type MyActivityItem } from '@portal/lib/api';
import { actionLabel, entityLabel } from '@portal/lib/auditFormat';
import { exportCsv } from '@portal/lib/listTools';
import { naturalCompare } from '@portal/lib/naturalSort';

import { errorText } from '../../lib/sirdarApi';

function recordLabel(r: MyActivityItem): string {
  const label = entityLabel(r);
  if (r.entity_name) return `${label} '${r.entity_name}'`;
  if (r.entity_type === 'auth' || !r.entity_id) return label;
  return `${label} · ${r.entity_id}`;
}

function optionsOf(rows: MyActivityItem[], value: (r: MyActivityItem) => string,
                   label: (r: MyActivityItem) => string) {
  const m = new Map<string, string>();
  for (const r of rows) m.set(value(r), label(r));
  return [...m.entries()].sort((a, b) => naturalCompare(a[1], b[1]))
    .map(([v, l]) => ({ value: v, label: l }));
}

export default function MeHistory() {
  const [rows, setRows] = useState<MyActivityItem[] | null>(null);
  const [error, setError] = useState('');
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');

  useEffect(() => {
    getMyActivityRequest()
      .then((r) => setRows([...r].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))))
      .catch((e) => { setRows([]); setError(errorText(e, "Couldn't load your history.")); });
  }, []);

  const all = useMemo(() => rows ?? [], [rows]);
  const actions = useMemo(() => optionsOf(all, (r) => r.action, actionLabel), [all]);
  const entities = useMemo(() => optionsOf(all, (r) => r.entity_type, entityLabel), [all]);
  const visible = all.filter((r) => (!action || r.action === action)
    && (!entityType || r.entity_type === entityType));

  return (
    <div className="panel activity-panel">
      <div className="panel-head">
        <h3>History</h3>
        <div className="activity-tools">
          <ComboBox ariaLabel="Action" placeholder="All actions" clearable value={action}
                    onChange={setAction} options={actions} />
          <ComboBox ariaLabel="Record type" placeholder="All record types" clearable value={entityType}
                    onChange={setEntityType} options={entities} />
          <button type="button" className="mini-btn" disabled={visible.length === 0}
                  onClick={() => exportCsv<MyActivityItem>('my-history', [
                    ['At', (r) => r.at],
                    ['Action', (r) => actionLabel(r)],
                    ['Record type', (r) => r.entity_type],
                    ['Record', (r) => recordLabel(r)],
                    ['IP', (r) => r.ip ?? ''],
                  ], visible)}>
            Download CSV
          </button>
          <span className="result-count">{visible.length} of {all.length}</span>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <DataTable
        ariaLabel="History"
        columns={[{ key: 'at', label: 'When', mono: true }, { key: 'action', label: 'Action' },
                  { key: 'record', label: 'Record' }, { key: 'ip', label: 'IP', mono: true }]}
        rows={visible.map((r) => ({
          key: r.id,
          cells: [new Date(r.at).toLocaleString(), actionLabel(r), recordLabel(r), r.ip ?? '—'],
        }))}
        emptyText={rows === null ? 'Loading…' : all.length === 0 ? 'No activity yet.' : 'No matching events.'}
      />
    </div>
  );
}
