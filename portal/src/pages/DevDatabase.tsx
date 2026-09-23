/**
 * Developer → Database — two tabs sharing one page shell:
 *
 *  - Reconcile: the god-mode "pending delete" registry (Task 1/2's
 *    mark/unmark flow, exposed everywhere via GodDeleteButton). Lists
 *    every entity currently marked for hard-delete, grouped by entity
 *    type, and offers the one action that actually deletes anything:
 *    Reconcile. POST /devtools/pending-deletes/reconcile runs each marked
 *    target in its own server-side savepoint (routes/devtools.py), so a
 *    handful of FK violations don't block the rest of the batch — a
 *    failed row keeps its marker for a later retry and comes back in the
 *    response's `failed` list. Structure/styling follows
 *    pages/Variables.tsx, the other dev-page exemplar.
 *
 *  - Backups: create/download/delete full-database SQL dumps, encrypted
 *    server-side with the caller's own account password
 *    (POST /devtools/backups — see lib/api.ts for the error codes).
 *
 *  - Testing: god-mode-gated "DB testing mode" — snapshot the database,
 *    let changes accumulate, then keep or revert them. Its own component,
 *    components/dev/DbTestingTab.tsx, since it's sizable on its own.
 *
 * Tab bar follows the .sysconf-tabbar pattern from pages/SystemConfig.tsx.
 */

import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import CascadeDeleteModal from '../components/dev/CascadeDeleteModal';
import DbTestingTab from '../components/dev/DbTestingTab';
import { RowActionsMenu } from '../components/hardware/RowActionsMenu';
import {
  ApiError,
  createDbBackup,
  deleteDbBackup,
  getDbBackupDownload,
  listDbBackups,
  listPendingDeletes,
  reconcilePendingDelete, reconcilePendingDeletes,
  unmarkPendingDelete,
  type DbBackupItem,
  type PendingDeleteFailure,
  type PendingDeleteItem,
  type PendingDeleteReconcileOut,
} from '../lib/api';
import { longDate, relativeTime } from '../lib/format';
import { ColHead, listGridStyle, type ColumnDef } from '../lib/listTools';
import { canForceDelete } from '../lib/pendingDeletes';
import '../styles/directory.css';
import '../styles/profile.css'; /* .btn-solid */
import '../styles/initiatives.css'; /* .init-panel, .mini-btn.sm */
import '../styles/system.css'; /* .sysconf-tabbar */

/** No tooltip for a blank cell — "—" repeated as a title on hover reads
 *  as noise, not information. */
const titleFor = (text: string) => (text === '—' ? undefined : text);

// Server-side failure codes -> plain-English explanation. Anything not
// listed here still renders (falls back to the raw code) rather than
// disappearing, so a new failure mode is visible even before this map
// is taught about it.
const FAILURE_REASONS: Record<string, string> = {
  fk_violation: 'Still referenced by other records — remove those references first.',
};

function humanizeReason(reason: string): string {
  return FAILURE_REASONS[reason] ?? reason;
}

function typeLabel(entityType: string): string {
  return entityType.replace(/_/g, ' ');
}

/** Trailing track for a row's RowActionsMenu — the "Actions ▾" trigger
 *  measures 85px, so 88px holds it without clipping and hands the rest of
 *  the old button-strip width back to the flexible columns. Same value as
 *  Warehouse.tsx:330 and InitiativeDetail.tsx's ACTIONS_TRACK. */
const ACTIONS_TRACK = '88px';

/** No column registry pre-migration (hand-written header spans) — this
 *  local COLUMNS mirrors them (recipe R1). The leading column's header text
 *  is the group's own "<Type> (<count>)" label, not a fixed "Name", so it's
 *  rebuilt per group in the render loop below rather than kept as a single
 *  module-level array; `min: 160` (primary-column floor) still guards it
 *  regardless of what that group text says. Fit is nowhere near the
 *  1176px page-level target — this list sits well under it either way. */
function reconcileColumns(entityType: string, count: number): ColumnDef[] {
  return [
    { key: 'entity_label', label: `${typeLabel(entityType)} (${count})`, width: '2fr', default: true, min: 160 },
    { key: 'entity_type', label: 'Type', width: '1fr', default: true },
    { key: 'marked_at', label: 'Marked', width: '1fr', default: true, min: 96 },
    { key: 'marked_by', label: 'Marked by', width: '1.3fr', default: true },
  ];
}

/** Reconcile tab body — unchanged from the pre-tab page other than the
 *  outer `.portal-page`/`.dir-head` wrapper, which the shell (below) now
 *  owns so the page has one eyebrow/title regardless of which tab is
 *  active; this tab's own explanatory copy stays as its lead paragraph. */
function ReconcileTab() {
  const [items, setItems] = useState<PendingDeleteItem[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [result, setResult] = useState<PendingDeleteReconcileOut | null>(null);
  const [cascadeFor, setCascadeFor] = useState<PendingDeleteFailure | null>(null);

  const load = async () => {
    try {
      setItems(await listPendingDeletes());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view pending deletes.'
        : 'Failed to load pending deletes.');
    }
  };

  useEffect(() => { void load(); }, []);

  const groups = useMemo(() => {
    if (!items) return [];
    const byType = new Map<string, PendingDeleteItem[]>();
    for (const item of items) {
      const list = byType.get(item.entity_type) ?? [];
      list.push(item);
      byType.set(item.entity_type, list);
    }
    return [...byType.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [items]);

  const total = items?.length ?? 0;

  const handleUndo = async (item: PendingDeleteItem) => {
    setBusyId(item.id);
    try {
      await unmarkPendingDelete(item.id);
      setItems((cur) => (cur ?? []).filter((i) => i.id !== item.id));
    } catch {
      setError('Could not undo — try again.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteOne = async (item: PendingDeleteItem) => {
    if (!confirm(`Permanently delete "${item.entity_label || item.entity_type}"? This cannot be undone.`)) {
      return;
    }
    setBusyId(item.id);
    setError('');
    setResult(null);
    try {
      const out = await reconcilePendingDelete(item.id);
      setResult(out);
      await load(); // resolved markers are gone server-side; failures stay
    } catch {
      setError('Delete failed — try again.');
    } finally {
      setBusyId(null);
    }
  };

  /** Failure payloads don't carry the marker id (they're keyed by entity),
   *  so force-delete resolves it client-side against the loaded items —
   *  the marker for a failed target is always still present (reconcile
   *  only clears markers it actually resolved). */
  const markerIdFor = (failure: PendingDeleteFailure): string | undefined =>
    (items ?? []).find(
      (i) => i.entity_type === failure.entity_type && i.entity_id === failure.entity_id,
    )?.id;

  const handleForceDelete = async (failure: PendingDeleteFailure) => {
    const markerId = markerIdFor(failure);
    if (!markerId) return;
    const parts = failure.references.map((r) => r.purgeable
      ? `remove ${r.count} ${r.table} row${r.count === 1 ? '' : 's'}`
      : `clear ${r.table}.${r.column} on ${r.count} row${r.count === 1 ? '' : 's'}`);
    if (!confirm(
      `Force delete "${failure.label || failure.entity_type}"? This will ${parts.join(', ')}, `
      + 'then permanently delete the record. This cannot be undone.',
    )) {
      return;
    }
    setBusyId(markerId);
    setError('');
    try {
      const out = await reconcilePendingDelete(markerId, true);
      setResult(out);
      await load();
    } catch {
      setError('Force delete failed — try again.');
    } finally {
      setBusyId(null);
    }
  };

  const handleReconcile = async () => {
    if (total === 0) return;
    if (!confirm(
      `Permanently delete ${total} record${total === 1 ? '' : 's'}? This cannot be undone.`,
    )) {
      return;
    }
    setReconciling(true);
    setError('');
    setResult(null);
    try {
      const out = await reconcilePendingDeletes();
      setResult(out);
      await load(); // server clears every marker it resolved; reload to match
    } catch {
      setError('Reconcile failed — try again.');
    } finally {
      setReconciling(false);
    }
  };

  // Same marker lookup handleForceDelete relies on — a failure's marker
  // is always still present (reconcile only clears markers it resolved),
  // but the type stays optional since nothing guarantees that statically.
  const cascadeMarkerId = cascadeFor ? markerIdFor(cascadeFor) : undefined;

  return (
    <>
      <p className="page-hint" style={{ marginBottom: 16 }}>
        Records marked for permanent deletion across the portal. Reconcile hard-deletes
        every marked record; anything still referenced elsewhere fails safely and stays
        listed here for a later retry.
      </p>

      <div className="dir-toolbar">
        <span className="result-count">{total} pending</span>
        <button
          type="button"
          className="btn-solid btn-danger"
          disabled={total === 0 || reconciling}
          onClick={() => void handleReconcile()}
        >
          {reconciling
            ? 'Reconciling…'
            : `Reconcile — permanently delete ${total} record${total === 1 ? '' : 's'}`}
        </button>
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>Cannot load pending deletes</b>{error}
        </div>
      )}

      {result && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>Reconcile complete</b>
          {result.deleted} deleted{result.failed.length > 0 && `, ${result.failed.length} failed`}.
          {result.failed.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, textAlign: 'left' }}>
              {result.failed.map((f) => {
                const canForce = canForceDelete(f.references);
                return (
                  <li key={`${f.entity_type}:${f.entity_id}`} style={{ marginBottom: 8 }}>
                    <b>{f.label}</b> — {humanizeReason(f.reason)}
                    {f.references.length > 0 && (
                      <ul style={{
                        margin: '4px 0 0', paddingLeft: 18,
                        color: 'var(--text-mute)', fontSize: 12, fontWeight: 300,
                      }}
                      >
                        {f.references.map((r) => (
                          <li key={`${r.table}.${r.column}`}>
                            {r.table}.{r.column} — {r.count} row{r.count === 1 ? '' : 's'}
                            {r.labels.length > 0 && ` ("${r.labels.join('", "')}")`}
                            {r.db_handled
                              && ' — handled automatically by the database'}
                            {r.check_guarded
                              && ' — kept non-null by a database rule; delete these rows first'}
                          </li>
                        ))}
                      </ul>
                    )}
                    {f.references.length > 0 && (
                      <div className="dev-cascade-actions">
                        {canForce && (
                          <button
                            type="button"
                            className="mini-btn sm danger"
                            disabled={busyId !== null}
                            onClick={() => void handleForceDelete(f)}
                          >
                            Force delete — detach references
                          </button>
                        )}
                        <button
                          type="button"
                          className="mini-btn sm danger"
                          disabled={busyId !== null}
                          onClick={() => setCascadeFor(f)}
                        >
                          Override — delete this and everything attached
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {!error && items && total === 0 && (
        <div className="dir-empty"><b>Nothing pending delete.</b></div>
      )}

      {!error && groups.map(([entityType, rows]) => {
        const cols = reconcileColumns(entityType, rows.length);
        const grid = listGridStyle(cols, [ACTIONS_TRACK]);
        const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };
        return (
          <div key={entityType} className="dir-list list-scroll" style={{ marginBottom: 20 }}>
            <div className="list-head" style={rowStyle}>
              {cols.map((c) => <ColHead key={c.key} col={c} />)}
              <span />
            </div>
            {rows.map((item) => (
              <div key={item.id} className="dir-row" style={{ minWidth: rowStyle.minWidth }}>
                <div className="row-main" style={rowStyle}>
                  <div className="cell">
                    <span className="cell-top cell-line" title={titleFor(item.entity_label || '—')}>
                      {item.entity_label || '—'}
                    </span>
                  </div>
                  <div className="cell"><span className="chip tag">{typeLabel(item.entity_type)}</span></div>
                  <div className="cell">
                    <span className="mono cell-line" title={longDate(item.marked_at)}>
                      {relativeTime(item.marked_at)}
                    </span>
                  </div>
                  <div className="cell">
                    <span className="cell-top cell-line" title={titleFor(item.marked_by_name ?? 'Unknown')}>
                      {item.marked_by_name ?? 'Unknown'}
                    </span>
                  </div>
                  {/* The row itself isn't clickable, so no stopPropagation
                      wrapper is needed here. Both items stay present while the
                      row is in flight — disabled, not dropped. */}
                  <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <RowActionsMenu actions={[
                      {
                        key: 'undo',
                        label: 'Undo',
                        onSelect: () => void handleUndo(item),
                        disabled: busyId === item.id,
                      },
                      {
                        key: 'delete',
                        label: 'Delete',
                        destructive: true,
                        onSelect: () => void handleDeleteOne(item),
                        disabled: busyId === item.id,
                      },
                    ]} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        );
      })}

      {cascadeFor && cascadeMarkerId && (
        <CascadeDeleteModal
          markerId={cascadeMarkerId}
          label={cascadeFor.label}
          onClose={() => setCascadeFor(null)}
          onDeleted={(res) => {
            const overridden = cascadeFor;
            setCascadeFor(null);
            // Merge into whatever's on screen rather than replacing it: the
            // override resolves one failure from a preceding bulk
            // Reconcile, and the other failures (with their own Override
            // buttons) must stay visible for the operator to work through.
            setResult((prev) => (prev ? {
              deleted: prev.deleted + res.deleted,
              failed: [
                ...prev.failed.filter((f) => !(overridden
                  && f.entity_type === overridden.entity_type
                  && f.entity_id === overridden.entity_id)),
                ...res.failed,
              ],
            } : res));
            void load();
          }}
        />
      )}
    </>
  );
}

// ── backups ──────────────────────────────────────────────────────────

/** No column registry pre-migration (hand-written header spans) — this
 *  local COLUMNS mirrors them (recipe R1). */
const BACKUP_COLUMNS: ColumnDef[] = [
  { key: 'filename', label: 'Filename', width: '2fr', default: true, min: 160 },
  { key: 'created_at', label: 'Created', width: '1.2fr', default: true, min: 96 },
  { key: 'size_bytes', label: 'Size', width: '1fr', default: true },
  { key: 'created_by', label: 'Creator', width: '1.3fr', default: true },
];

const DECRYPT_HINT =
  'openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -in <file> -out backup.sql';

/** KB/MB(/GB) with one decimal — plain bytes below 1 KB. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Triggers a browser download from a (possibly presigned) URL without
 *  navigating the SPA away from the page — a detached, immediately-clicked
 *  anchor, same trick used for attachment downloads elsewhere in the
 *  portal. `filename` is only a hint; the presigned URL already carries
 *  an attachment Content-Disposition set server-side. */
function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function createErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'invalid_password') return "That password doesn't match your account.";
    if (err.code === 'pg_dump_unavailable') return "pg_dump isn't installed on the server.";
  }
  return 'Could not create the backup — try again.';
}

function BackupsTab() {
  const { can } = useAuth();
  const canChange = can('devtools', 'change');
  // Neither DevDatabase tab reads UiPreferences today (ReconcileTab has no
  // useAuth() call at all) — scale is omitted rather than adding that
  // dependency just for list_size; listGridStyle defaults to scale 1.
  const backupGrid = listGridStyle(BACKUP_COLUMNS, [ACTIONS_TRACK]);
  const backupRowStyle = {
    gridTemplateColumns: backupGrid.gridTemplateColumns, minWidth: backupGrid.minWidth,
  };

  const [backups, setBackups] = useState<DbBackupItem[] | null>(null);
  const [listError, setListError] = useState('');
  const [password, setPassword] = useState('');
  const [encrypt, setEncrypt] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    try {
      setBackups(await listDbBackups());
      setListError('');
    } catch {
      setListError('Failed to load backups.');
    }
  };

  useEffect(() => { void load(); }, []);

  const handleCreate = async () => {
    if (encrypt && !password) return;
    setCreating(true);
    setCreateError('');
    try {
      const created = await createDbBackup(encrypt ? password : null);
      setPassword('');
      await load();
      if (created.download_url) triggerDownload(created.download_url, created.filename);
    } catch (err) {
      setCreateError(createErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const handleDownload = async (item: DbBackupItem) => {
    setBusyId(item.id);
    setListError('');
    try {
      const { url } = await getDbBackupDownload(item.id);
      triggerDownload(url, item.filename);
    } catch {
      setListError('Could not get a download link — try again.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (item: DbBackupItem) => {
    if (!confirm(`Delete backup ${item.filename}? This cannot be undone.`)) return;
    setBusyId(item.id);
    setListError('');
    try {
      await deleteDbBackup(item.id);
      await load();
    } catch {
      setListError('Delete failed — try again.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      {/* sysconf-card scopes system.css's input styling to this form */}
      <div className="init-panel sysconf-card" style={{ marginBottom: 20 }}>
        <div className="eyebrow-sm">Create backup</div>
        <p className="page-hint" style={{ marginTop: 0 }}>
          {encrypt
            ? 'Creates a full SQL dump encrypted with your account password. Keep the password — the file cannot be decrypted without it.'
            : 'Creates a plain, UNENCRYPTED SQL dump — anyone with the file can read the whole database.'}
        </p>

        {canChange ? (
          <>
            <label className="init-check" style={{ marginBottom: 12 }}>
              <input
                type="checkbox"
                checked={encrypt}
                disabled={creating}
                onChange={(e) => { setEncrypt(e.target.checked); setCreateError(''); }}
              />
              Encrypt with my account password
            </label>
            {encrypt && (
              <div className="sysconf-row">
                <div className="sysconf-field">
                  <label className="sysconf-label" htmlFor="db-backup-password">
                    Your account password
                  </label>
                  <input
                    id="db-backup-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    disabled={creating}
                    onChange={(e) => { setPassword(e.target.value); setCreateError(''); }}
                  />
                </div>
              </div>
            )}
            <div>
              <button
                type="button"
                className="btn-solid"
                disabled={creating || (encrypt && !password)}
                onClick={() => void handleCreate()}
              >
                {creating ? 'Backing up…'
                  : encrypt ? 'Create encrypted backup' : 'Create plain backup'}
              </button>
            </div>
            {createError && <p className="pf-error">{createError}</p>}
            {encrypt && (
              <p className="page-hint" style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
                Decrypt with: {DECRYPT_HINT}
              </p>
            )}
          </>
        ) : (
          <p className="page-hint" style={{ marginBottom: 0 }}>
            You do not have permission to create backups.
          </p>
        )}
      </div>

      {listError && <p className="pf-error">{listError}</p>}

      <div className="dir-list list-scroll">
        <div className="list-head" style={backupRowStyle}>
          {BACKUP_COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
          <span />
        </div>
        {backups && backups.length === 0 && (
          <div className="dir-empty"><b>No backups yet.</b></div>
        )}
        {(backups ?? []).map((b) => (
          <div key={b.id} className="dir-row" style={{ minWidth: backupRowStyle.minWidth }}>
            <div className="row-main" style={backupRowStyle}>
              <div className="cell">
                <span className="cell-top cell-line" title={titleFor(b.filename)}>
                  {b.filename}
                  {!b.encrypted && (
                    <span className="chip tag" style={{ marginLeft: 8 }}>plain</span>
                  )}
                  {b.purpose === 'testing_snapshot' && (
                    <span className="chip tag" style={{ marginLeft: 8 }}>Testing snapshot</span>
                  )}
                </span>
              </div>
              <div className="cell">
                <span className="mono cell-line" title={relativeTime(b.created_at)}>
                  {longDate(b.created_at)}
                </span>
              </div>
              <div className="cell"><span className="mono cell-line">{formatBytes(b.size_bytes)}</span></div>
              <div className="cell">
                <span className="cell-top cell-line" title={titleFor(b.created_by_name ?? 'Unknown')}>
                  {b.created_by_name ?? 'Unknown'}
                </span>
              </div>
              {/* Download stays visible while it's in flight (disabled, not
                  dropped) — dropping it would take the whole trigger away
                  mid-download for a user without devtools:change. */}
              <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <RowActionsMenu actions={[
                  {
                    key: 'download',
                    label: 'Download',
                    onSelect: () => void handleDownload(b),
                    disabled: busyId === b.id,
                  },
                  ...(canChange ? [{
                    key: 'delete',
                    label: 'Delete',
                    destructive: true,
                    onSelect: () => void handleDelete(b),
                    disabled: busyId === b.id,
                  }] : []),
                ]} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ── page shell ───────────────────────────────────────────────────────

const TABS = [
  { key: 'reconcile', label: 'Reconcile' },
  { key: 'backups', label: 'Backups' },
  { key: 'testing', label: 'Testing' },
] as const;

export default function DevDatabase() {
  const [tab, setTab] = useState<typeof TABS[number]['key']>('reconcile');

  return (
    <div className="portal-page">
      <div className="eyebrow">Developer</div>
      <h1 className="page-title">Database</h1>

      <div className="sysconf-tabbar" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`sysconf-tab${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'reconcile' && <ReconcileTab />}
      {tab === 'backups' && <BackupsTab />}
      {tab === 'testing' && <DbTestingTab />}
    </div>
  );
}
