/** One place's versions: number, state, who saved it and when, today's test
 *  result (a Live version that now fails is flagged), and the row's Actions
 *  menu. Clicking a row selects it. */

import DataTable, { type DataTableColumn, type DataTableRow } from '../DataTable';
import { RowActionsMenu, type RowAction } from '../hardware/RowActionsMenu';
import type { MatchingVersion } from '../../lib/api';
import { ACTIONS_TRACK } from '../../lib/listTools';
import { formatSavedAt, STATE_CHIP, STATE_LABELS } from '../../lib/matchingRules';

const COLUMNS: DataTableColumn[] = [
  { key: 'version', label: 'Version', width: '90px', mono: true },
  { key: 'state', label: 'State', width: '120px' },
  { key: 'saved_by', label: 'Saved by' },
  { key: 'saved_at', label: 'Saved', mono: true },
  { key: 'tests', label: 'Tests' },
  { key: 'actions', label: '', width: ACTIONS_TRACK, align: 'right' },
];

export default function VersionsTable({
  versions, selectedId, onSelect, onOpen, onDeploy, onRollback,
}: {
  versions: MatchingVersion[];
  selectedId: string | null;
  onSelect: (v: MatchingVersion) => void;
  onOpen: (v: MatchingVersion) => void;
  onDeploy: (v: MatchingVersion) => void;
  onRollback: (v: MatchingVersion) => void;
}) {
  const rows: DataTableRow[] = versions.map((v) => {
    const actions: RowAction[] = [{ key: 'open', label: 'Open', onSelect: () => onOpen(v) }];
    if (v.state === 'draft' || v.state === 'standby') {
      actions.push({ key: 'deploy', label: 'Deploy', onSelect: () => onDeploy(v) });
    }
    if (v.state === 'retired') {
      actions.push({ key: 'rollback', label: 'Roll back to', onSelect: () => onRollback(v) });
    }
    return {
      key: v.id,
      selected: v.id === selectedId,
      onClick: () => onSelect(v),
      cells: [
        `v${v.version}`,
        <span key="state" className={STATE_CHIP[v.state]}>
          {STATE_LABELS.find((s) => s.key === v.state)?.label ?? v.state}
        </span>,
        <span key="saved_by" className="cell-top cell-line">{v.saved_by_name ?? 'System'}</span>,
        <span key="saved_at">{formatSavedAt(v.saved_at)}</span>,
        <span key="tests" className="mr-tests-cell">
          <span className="mono">{v.current.passed} of {v.current.total}</span>
          {v.state === 'live' && !v.current.ok && <span className="chip c-red">Fails today&apos;s test set</span>}
        </span>,
        <div key="actions" className="mr-actions"><RowActionsMenu actions={actions} /></div>,
      ],
    };
  });
  return <DataTable ariaLabel="Versions" className="mr-versions" columns={COLUMNS} rows={rows} />;
}
