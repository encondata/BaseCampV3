/**
 * MatrixTable — the one grid that renders three different jobs:
 *  - 'role':      editing a role's grants (checkbox per resource × action)
 *  - 'override':  editing a person's overrides (tri-state, ghosted inherit)
 *  - 'effective':  read-only resolved access (with source annotations)
 */

import type { Action } from '../../lib/access';
import { ACTIONS } from '../../lib/access';
import type { AccessResourceOut, EffectiveCell } from '../../lib/api';
import DataTable, { type DataTableColumn, type DataTableRow } from '../DataTable';

export type CellMode = 'role' | 'override' | 'effective';

export interface MatrixTableProps {
  mode: CellMode;
  resources: AccessResourceOut[];
  /** role mode: current grants. */
  matrix?: Record<string, Record<Action, boolean>>;
  /** effective mode: EffectiveOut.cells. */
  cells?: Record<string, Record<Action, EffectiveCell>>;
  /** override mode: sparse tri-state overrides. */
  overrides?: Record<string, Partial<Record<Action, boolean>>>;
  /** override mode: inherited effective value, used for ghosting + tooltip. */
  inherited?: Record<string, Record<Action, boolean>>;
  editable: boolean;
  lockedResources?: Set<string>;
  lockedCells?: Set<string>;
  onToggle?: (resource: string, action: Action) => void;
  onCycle?: (resource: string, action: Action) => void;
  onToggleColumn?: (action: Action) => void;
}

const CHECK = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2"
       strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 6.3 4.8 9 10 3" />
  </svg>
);

const CROSS = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2"
       strokeLinecap="round"><path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" /></svg>
);

const LOCK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

export default function MatrixTable({
  mode, resources, matrix, cells, overrides, inherited, editable,
  lockedResources, lockedCells, onToggle, onCycle, onToggleColumn,
}: MatrixTableProps) {
  const isLockedCell = (resId: string, action: Action) =>
    Boolean(lockedResources?.has(resId)) || Boolean(lockedCells?.has(`${resId}:${action}`));

  const columns: DataTableColumn[] = [
    { key: 'resource', label: '' },
    ...ACTIONS.map((a): DataTableColumn => ({
      key: a,
      label: (
        <div className="pm-col-head">
          <span>{a}</span>
          {editable && onToggleColumn && (
            <button type="button" className="pm-col-toggle"
                    title={`Toggle ${a} for every row`}
                    onClick={() => onToggleColumn(a)}>
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round">
                <path d="M2 6h8M6 2v8" />
              </svg>
            </button>
          )}
        </div>
      ),
    })),
  ];

  const rows: DataTableRow[] = resources.map((res) => ({
    key: res.id,
    cells: [
      <div className="pm-res-label">
        {res.label}
        {res.developer_only && (
          <span className="pm-lock-glyph" title="Developer-only resource">{LOCK}</span>
        )}
      </div>,
      ...ACTIONS.map((a) => (
        <div className="pm-cell" key={a}>
          {mode === 'role' && (
            <RoleCell resource={res} action={a} matrix={matrix}
                      editable={editable} locked={isLockedCell(res.id, a)}
                      onToggle={onToggle} />
          )}
          {mode === 'override' && (
            <OverrideCell resource={res} action={a} overrides={overrides}
                          inherited={inherited} editable={editable}
                          locked={isLockedCell(res.id, a)} onCycle={onCycle} />
          )}
          {mode === 'effective' && (
            <EffectiveCellView resource={res} action={a} cells={cells} />
          )}
        </div>
      )),
    ],
  }));

  return (
    <div className="pm-scroll">
      <DataTable ariaLabel="Permission matrix" className="pm-table" columns={columns} rows={rows} />
    </div>
  );
}

function RoleCell({ resource, action, matrix, editable, locked, onToggle }: {
  resource: AccessResourceOut; action: Action;
  matrix?: Record<string, Record<Action, boolean>>;
  editable: boolean; locked: boolean;
  onToggle?: (resource: string, action: Action) => void;
}) {
  const on = matrix?.[resource.id]?.[action] === true;
  const disabled = !editable || locked;
  return (
    <button type="button" className={`pm-chk ${on ? 'on' : ''}`} disabled={disabled}
            title={locked ? 'Locked' : undefined}
            onClick={() => onToggle?.(resource.id, action)}>
      {locked ? LOCK : (on ? CHECK : null)}
    </button>
  );
}

function OverrideCell({ resource, action, overrides, inherited, editable, locked, onCycle }: {
  resource: AccessResourceOut; action: Action;
  overrides?: Record<string, Partial<Record<Action, boolean>>>;
  inherited?: Record<string, Record<Action, boolean>>;
  editable: boolean; locked: boolean;
  onCycle?: (resource: string, action: Action) => void;
}) {
  const raw = overrides?.[resource.id]?.[action];
  const state: 'inherit' | 'allow' | 'deny' =
    raw === true ? 'allow' : raw === false ? 'deny' : 'inherit';
  const inheritedValue = inherited?.[resource.id]?.[action] === true;
  const effective = state === 'inherit' ? inheritedValue : state === 'allow';
  const disabled = !editable || locked;
  const title = locked
    ? 'Locked'
    : `${state} (effective: ${effective ? 'allowed' : 'denied'})`;

  return (
    <button type="button" className={`pm-tri ${state}`} disabled={disabled} title={title}
            onClick={() => onCycle?.(resource.id, action)}>
      {locked ? LOCK : state === 'allow' ? CHECK : state === 'deny' ? CROSS
        : <span className="pm-ghost">{inheritedValue ? CHECK : CROSS}</span>}
    </button>
  );
}

function EffectiveCellView({ resource, action, cells }: {
  resource: AccessResourceOut; action: Action;
  cells?: Record<string, Record<Action, EffectiveCell>>;
}) {
  const cell = cells?.[resource.id]?.[action];
  const value = cell?.value === true;
  const source = cell?.source;
  const cls = ['pm-eff', value ? 'yes' : 'no', source === 'override' ? 'ov' : '']
    .filter(Boolean).join(' ');
  const title = source ? `source: ${source}` : undefined;
  return (
    <span className={cls} title={title}>
      {source === 'hard_gate' ? LOCK : (value ? CHECK : CROSS)}
    </span>
  );
}
