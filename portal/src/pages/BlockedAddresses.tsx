/** System › Blocked addresses (SS-487): network addresses blocked from
 *  signing in after too many failed attempts. Admin rank and above.
 *
 *  A plain directory list on the SystemProcesses model (static column
 *  registry, ColHead labels, listGridStyle floors, .list-scroll card) with
 *  the standard RowActionsMenu "Actions ▾" in an ACTIONS_TRACK end column,
 *  as on Fixed Readers. The segmented Active | Ended filter follows the
 *  Notifications inbox. Labels and actions come from `status` only. */

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import {
  ApiError, blockAddressPermanently, clearAddressBlock, listBlockedAddresses,
  type BlockedAddress,
} from '../lib/api';
import { localDateTime } from '../lib/importReport';
import {
  ACTIONS_TRACK, ColHead, listGridStyle, listScale, titleFor, type ColumnDef,
} from '../lib/listTools';
import { RowActionsMenu, type RowAction } from '../components/hardware/RowActionsMenu';
import '../styles/directory.css';

type Show = 'active' | 'ended';

// Fit: these columns + ACTIONS_TRACK ≤ LIST_FIT.page (asserted in the test).
// To stay inside it, the trip's failure count is the Times blocked cell's
// hover title and the last try's time is the Tries cell's.
// Dates are mono `YYYY-MM-DD HH:MM`; Address holds an IPv6 /64 at 160px
// and truncates with a hover title past that.
export const BLOCKED_ADDRESS_COLUMNS: ColumnDef[] = [
  { key: 'address', label: 'Address', width: '1.3fr', default: true, min: 160 },
  { key: 'status', label: 'Status', width: '104px', default: true },
  { key: 'ends', label: 'Ends', width: '1fr', default: true, min: 132 },
  { key: 'times_blocked', label: 'Times blocked', short: 'Times', width: '72px', default: true },
  { key: 'attempts', label: 'Tries while blocked', short: 'Tries', width: '72px', default: true },
  { key: 'last_route', label: 'Last route tried', short: 'Route', width: '1fr', default: true, min: 132 },
  { key: 'first_blocked', label: 'First blocked', short: 'First', width: '1fr', default: true, min: 132 },
  { key: 'last_blocked', label: 'Last blocked', short: 'Last', width: '1fr', default: true, min: 132 },
];

const LEVEL_HOURS: Record<number, number> = { 1: 1, 2: 6, 3: 12, 4: 24 };

const ROUTE_LABELS: Record<string, string> = {
  login: 'Password sign-in',
  totp_verify: '2FA code',
  move_login: 'Move password',
  biometric_sign_in: 'Biometric sign-in',
  password_reset_check: 'Password reset link',
  password_reset_confirm: 'Password reset link',
};

export function statusLabel(b: BlockedAddress): string {
  if (b.status === 'permanent') return 'Permanent';
  if (b.status === 'ended') return 'Ended';
  const hours = LEVEL_HOURS[b.level];
  return hours ? `Blocked ${hours} h` : 'Blocked';
}

const STATUS_CHIP: Record<string, string> = {
  blocked: 'c-amber', permanent: 'c-red', ended: 'c-slate',
};

const when = (iso: string | null): string => (iso ? localDateTime(new Date(iso)) : '—');

/** Ends: the scheduled end for a timed block, — when permanent, and the
 *  time it actually ended for an ended row. */
const endsText = (b: BlockedAddress): string => {
  if (b.status === 'permanent') return '—';
  if (b.status === 'ended') return when(b.ended_at);
  return when(b.ends_at);
};

const EMPTY: Record<Show, string> = {
  active: 'No addresses are blocked.',
  ended: 'No blocks ended in the last 30 days.',
};

const msgFor = (err: unknown): string => {
  if (err instanceof ApiError && (err.code === 'block_not_active' || err.code === 'block_not_found')) {
    return 'This block has already ended or changed.';
  }
  return err instanceof ApiError ? `Request failed (${err.code}).` : "Couldn't update the block.";
};

export default function BlockedAddresses() {
  const { preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const [show, setShow] = useState<Show>('active');
  const [rows, setRows] = useState<BlockedAddress[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (which: Show) => {
    try {
      setRows(await listBlockedAddresses(which));
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof ApiError && err.status === 403
        ? "You don't have access to blocked addresses."
        : "Couldn't load blocked addresses.");
    }
  }, []);

  useEffect(() => { setRows(null); void load(show); }, [show, load]);

  const run = async (b: BlockedAddress, call: (address: string) => Promise<BlockedAddress>) => {
    setActionError('');
    setBusy(b.address);
    try {
      await call(b.address);
    } catch (err) {
      setActionError(msgFor(err));
    } finally {
      setBusy(null);
      await load(show);
    }
  };

  const actionsFor = (b: BlockedAddress): RowAction[] => {
    if (b.status === 'ended') return [];
    const disabled = busy === b.address;
    return [
      { key: 'clear', label: 'Clear block', disabled, onSelect: () => void run(b, clearAddressBlock) },
      ...(b.status === 'blocked'
        ? [{
          key: 'permanent', label: 'Block permanently', destructive: true, disabled,
          onSelect: () => void run(b, blockAddressPermanently),
        }]
        : []),
    ];
  };

  const mono = (text: string) => <span className="mono cell-line" title={titleFor(text)}>{text}</span>;

  const cellFor = (b: BlockedAddress, key: string) => {
    switch (key) {
      case 'address': return mono(b.address);
      case 'status':
        return <span className={`chip ${STATUS_CHIP[b.status] ?? 'c-slate'}`}>{statusLabel(b)}</span>;
      case 'ends': return mono(endsText(b));
      case 'times_blocked':
        return (
          <span className="mono cell-line" title={`This block tripped on ${b.failure_count} failed sign-ins`}>
            {b.times_blocked}
          </span>
        );
      case 'attempts': {
        const text = String(b.attempts_while_blocked);
        const title = b.last_attempt_at ? `Last try ${when(b.last_attempt_at)}` : 'No tries since the block';
        return <span className="mono cell-line" title={title}>{text}</span>;
      }
      case 'last_route': {
        const text = ROUTE_LABELS[b.last_route] ?? b.last_route;
        return <span className="cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'first_blocked': return mono(when(b.first_blocked_at));
      case 'last_blocked': return mono(when(b.blocked_at));
      default: return null;
    }
  };

  const grid = listGridStyle(BLOCKED_ADDRESS_COLUMNS, [ACTIONS_TRACK], undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">System</div>
          <h1 className="page-title">Blocked addresses</h1>
          <p className="page-hint">Networks blocked from signing in after too many failed attempts.</p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="segmented" role="group" aria-label="Show">
          <button type="button" className={show === 'active' ? 'on' : ''} aria-pressed={show === 'active'}
                  onClick={() => setShow('active')}>Active</button>
          <button type="button" className={show === 'ended' ? 'on' : ''} aria-pressed={show === 'ended'}
                  onClick={() => setShow('ended')}>Ended (last 30 days)</button>
        </div>
      </div>

      {(loadError || actionError) && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>{loadError ? 'Cannot load blocked addresses' : "Couldn't complete that action"}</b>
          {loadError || actionError}
        </div>
      )}

      {rows && (
        <div className="dir-list list-scroll">
          <div className="list-head" style={rowStyle}>
            {BLOCKED_ADDRESS_COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
            <span className="col-head" aria-hidden="true" />
          </div>

          {rows.length === 0 && <div className="dir-empty">{EMPTY[show]}</div>}

          {rows.map((b) => {
            const actions = actionsFor(b);
            return (
              <div key={b.address} className="dir-row" style={{ minWidth: rowStyle.minWidth }}>
                <div className="row-main" style={{ ...rowStyle, cursor: 'default' }}>
                  {BLOCKED_ADDRESS_COLUMNS.map((c) => (
                    <div className="cell" key={c.key}>{cellFor(b, c.key)}</div>
                  ))}
                  <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    {actions.length > 0 && <RowActionsMenu actions={actions} />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
