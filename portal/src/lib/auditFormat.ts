/**
 * Shared presentation for audit rows — used by the /me User history panel
 * and the Admin → Audit log viewer. One place for action/entity labels so
 * the two surfaces never drift.
 */

export interface AuditRowLike {
  action: string;
  entity_type: string;
  entity_id: string | null;
  changes: Record<string, unknown>;
  entity_name?: string | null;
  entity_summary?: Record<string, string>;
}

export const ACTION_LABELS: Record<string, string> = {
  login: 'Signed in',
  login_failed: 'Failed sign-in attempt',
  logout: 'Signed out',
  token_replay_detected: 'Token replay detected — sessions revoked',
  'password.change': 'Changed password',
  'session.revoke': 'Signed out another session',
  bulk_import: 'Ran a bulk import',
  create: 'Created',
  update: 'Updated',
  archive: 'Archived',
  restore: 'Unarchived',
  'clients.set': 'Changed client links',
  'survey.update': 'Updated survey',
  'godmode.enable': 'Enabled god mode',
};

export const ENTITY_LABELS: Record<string, string> = {
  auth: 'account',
  person: 'profile',
  user_account: 'account',
  site: 'site',
  site_type: 'site type',
  site_bulk_import: 'sites (bulk)',
  status_value: 'status value',
  worker: 'worker',
  worker_level: 'worker level',
  access_group: 'access group',
  role: 'role',
  resource: 'access matrix',
  asset: 'asset',
  asset_model: 'asset model',
  container: 'container',
};

export function actionLabel(row: AuditRowLike): string {
  return ACTION_LABELS[row.action] ?? row.action.replace(/[._]/g, ' ');
}

export function entityLabel(row: AuditRowLike): string {
  return ENTITY_LABELS[row.entity_type] ?? row.entity_type.replace(/_/g, ' ');
}

/** "site 'Acme DC1'" when the changes carry a recognizable name.
 * Auth rows show the identity involved (an email for failed logins)
 * unless `hideAuthTarget` — the /me panel hides it for the user's own
 * rows where it is just themselves. */
export function targetLabel(row: AuditRowLike, opts?: { hideAuthTarget?: boolean }): string {
  if (row.entity_type === 'auth') {
    return opts?.hideAuthTarget ? '—' : (row.entity_id ?? '—');
  }
  const label = entityLabel(row);
  // server-resolved current name wins; fall back to a name captured in the
  // change diff (covers records deleted since)
  if (row.entity_name) return `${label} '${row.entity_name}'`;
  for (const key of ('name' in row.changes ? ['name'] : ['label', 'title'])) {
    const change = row.changes[key];
    if (change && typeof change === 'object' && 'to' in change) {
      const to = (change as { to?: unknown }).to;
      if (typeof to === 'string' && to) return `${label} '${to}'`;
    }
  }
  return label;
}

/** Multi-line tooltip for a record reference: resolved summary details
 * plus the raw id (kept findable without cluttering the visible line). */
export function recordTooltip(row: AuditRowLike): string {
  const lines = Object.entries(row.entity_summary ?? {})
    .map(([k, v]) => `${k}: ${v}`);
  if (row.entity_id) lines.push(`ID: ${row.entity_id}`);
  return lines.join('\n');
}

/** Where a record lives in the portal, or null when it has no page.
 * V3 records are rows in list pages, so "navigate to it" means the list
 * route plus ?open=<id> — every list initializes its expanded row from
 * that param. Worker and person audit rows both store the PERSON id,
 * which is exactly what Workers/Users rows are keyed by. */
export function entityHref(row: AuditRowLike): string | null {
  if (!row.entity_id) return null;
  const routes: Record<string, string> = {
    site: '/sites',
    worker: '/people/workers',
    person: '/people/users',
    user_account: '/people/users',
    client: '/stakeholders/clients',
    partner: '/stakeholders/partners',
    asset: '/assets',
    asset_model: '/admin/asset-models',
    container: '/logistics/containers',
  };
  const base = routes[row.entity_type];
  return base ? `${base}?open=${encodeURIComponent(row.entity_id)}` : null;
}

/** Lazy initializer for a list page's expanded-row state: honors a
 * ?open=<id> deep link (used by the audit viewers' Record links). */
export function initialOpenId(): string | null {
  return new URLSearchParams(window.location.search).get('open');
}

/** One rendered before/after pair. Values that aren't {from,to} objects
 * (bulk summaries, client add/remove sets) render as plain JSON. */
export function changeRows(changes: Record<string, unknown>):
  { field: string; from: string; to: string }[] {
  const show = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return '—';
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  return Object.entries(changes).map(([field, value]) => {
    if (value && typeof value === 'object' && ('from' in value || 'to' in value)) {
      const pair = value as { from?: unknown; to?: unknown };
      return { field, from: show(pair.from), to: show(pair.to) };
    }
    return { field, from: '—', to: show(value) };
  });
}
