/**
 * MembersTab — everyone holding any role: standard directory-list toolbar
 * (Filters / Columns / Export), a per-row global-role dropdown, and an
 * Overrides button that opens the tri-state OverrideEditor.
 */

import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { canTouchRank, RANK_LABELS, rolesPayloadForGlobalChange } from '../../lib/access';
import {
  ApiError, listMembers, setUserRoles,
  type AccessSummary, type MemberItem,
} from '../../lib/api';
import { avatarGradient, initials } from '../../lib/format';
import {
  ColumnsButton, ExportButton, FilterButton, exportCsv, passesFacets,
  type ColumnDef, type FacetGroup, type FacetState,
} from '../../lib/listTools';
import OverrideEditor from './OverrideEditor';

interface Props {
  summary: AccessSummary;
  canEdit: boolean;
  maxRank: number;
  onChanged: () => void;
}

const ERRORS: Record<string, string> = {
  rank_too_low: "Your rank is too low to change this member's roles.",
  cannot_target_self: 'You cannot change your own roles here.',
  role_requires_org: 'That role needs an org — manage it from the client/partner contacts page.',
  unknown_role: 'Unknown role — refresh and try again.',
};

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? (ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was saved.';

const rankLabel = (rank: number): string =>
  RANK_LABELS.find(([r]) => rank >= r)?.[1] ?? 'Custom';

const COLUMNS: ColumnDef[] = [
  { key: 'roles', label: 'Roles', width: '1.6fr', default: true },
  { key: 'rank', label: 'Rank', width: '1fr', default: true },
  { key: 'org', label: 'Org', width: '1.1fr', default: true },
];

type SortKey = 'name' | 'roles' | 'rank' | 'org';

export default function MembersTab({ summary, canEdit, maxRank, onChanged }: Props) {
  const { person: me } = useAuth();
  const selfId = me?.id ?? null;

  const [members, setMembers] = useState<MemberItem[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<FacetState>({});
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    () => new Set(COLUMNS.filter((c) => c.default).map((c) => c.key)));
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [overrideCounts, setOverrideCounts] = useState<Record<string, number>>({});
  const [editingOverridesFor, setEditingOverridesFor] = useState<MemberItem | null>(null);

  const load = () => {
    listMembers().then(setMembers).catch(() => setError('Failed to load members.'));
  };

  useEffect(() => { load(); }, []);

  const anchorByRole = useMemo<Record<string, string | undefined>>(
    () => Object.fromEntries(summary.roles.map((r) => [r.name, r.scope_anchor])),
    [summary.roles]);

  const orgFor = (m: MemberItem): string => {
    const anchors = new Set<string>();
    for (const name of m.roles) {
      const anchor = summary.roles.find((r) => r.name === name)?.scope_anchor;
      if (anchor && anchor !== 'global' && anchor !== 'self') anchors.add(anchor);
    }
    if (anchors.size === 0) return '—';
    return [...anchors].map((a) => a.charAt(0).toUpperCase() + a.slice(1)).join(', ');
  };

  // The dropdown edits a single "primary" global role at a time: options
  // are the global-anchor roles the viewer may touch (plus the member's
  // current one, so a disabled control still shows a real label instead
  // of the empty placeholder).
  const roleOptionsFor = (m: MemberItem) =>
    summary.roles
      .filter((r) => r.scope_anchor === 'global'
        && (canTouchRank(maxRank, r.rank) || m.roles.includes(r.name)))
      .map((r) => ({ value: r.name, label: r.label }));

  const currentGlobalRole = (m: MemberItem): string => {
    const owned = summary.roles
      .filter((r) => r.scope_anchor === 'global' && m.roles.includes(r.name))
      .sort((a, b) => b.rank - a.rank);
    return owned[0]?.name ?? '';
  };

  const facetGroups = useMemo<FacetGroup[]>(() => [
    { key: 'role', title: 'Role',
      options: summary.roles.map((r) => ({ value: r.name, label: r.label })) },
    { key: 'rank', title: 'Rank band',
      options: RANK_LABELS.map(([r, label]) => ({ value: String(r), label })) },
    { key: 'overrides', title: 'Overrides',
      options: [{ value: 'yes', label: 'Has overrides' }] },
  ], [summary.roles]);

  const visible = useMemo(() => {
    if (!members) return [];
    const q = query.trim().toLowerCase();
    const rows = members.filter((m) => {
      if (!passesFacets(facets, (g) => {
        if (g === 'role') return m.roles;
        if (g === 'rank') {
          const band = RANK_LABELS.find(([r]) => m.max_rank >= r)?.[0];
          return band !== undefined ? [String(band)] : [];
        }
        if (g === 'overrides') return (overrideCounts[m.person_id] ?? 0) > 0 ? ['yes'] : [];
        return [];
      })) return false;
      if (!q) return true;
      const hay = `${m.display_name} ${m.login_email ?? ''} ${m.roles.join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
    const val = (m: MemberItem): string | number => {
      switch (sortKey) {
        case 'name': return m.display_name.toLowerCase();
        case 'roles': return m.roles.join(',');
        case 'rank': return m.max_rank;
        case 'org': return orgFor(m);
      }
    };
    return rows.sort((a, b) => {
      const va = val(a), vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, facets, query, sortKey, sortDir, overrideCounts, summary.roles]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(1); }
  };
  const caret = (key: SortKey) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const shownCols = COLUMNS.filter((c) => visibleCols.has(c.key));
  const grid = { gridTemplateColumns: `2.2fr ${shownCols.map((c) => c.width).join(' ')} 1.2fr 110px` };

  const changeRole = async (member: MemberItem, newRole: string) => {
    setRowBusy((b) => ({ ...b, [member.person_id]: true }));
    setRowError((e) => ({ ...e, [member.person_id]: '' }));
    // Send the new global role + the member's self-anchored grants only.
    // Org-anchored (client/partner) names must be dropped, not resent —
    // the API 422s on them (role_requires_org) and preserves the grants
    // server-side even when absent from the payload.
    const nextRoles = rolesPayloadForGlobalChange(member.roles, anchorByRole, newRole);
    try {
      await setUserRoles(member.person_id, nextRoles);
      onChanged();
      load();
    } catch (err) {
      setRowError((e) => ({ ...e, [member.person_id]: msgFor(err) }));
    } finally {
      setRowBusy((b) => ({ ...b, [member.person_id]: false }));
    }
  };

  const cellFor = (m: MemberItem, key: string) => {
    switch (key) {
      case 'roles':
        return (
          <div className="chips">
            {m.roles.length === 0 && <span className="chip tag">no roles</span>}
            {m.roles.map((r) => (
              <span key={r} className="chip tag">
                {summary.roles.find((sr) => sr.name === r)?.label ?? r}
              </span>
            ))}
          </div>
        );
      case 'rank':
        return <span className="rank-badge">{m.max_rank} · {rankLabel(m.max_rank)}</span>;
      case 'org':
        return <span className="cell-top">{orgFor(m)}</span>;
      default:
        return null;
    }
  };

  const CSV_COLUMNS: [string, (m: MemberItem) => string][] = [
    ['Person ID', (m) => m.person_id],
    ['Name', (m) => m.display_name],
    ['Login email', (m) => m.login_email ?? ''],
    ['Roles', (m) => m.roles.join('; ')],
    ['Rank', (m) => String(m.max_rank)],
    ['Rank label', (m) => rankLabel(m.max_rank)],
    ['Org', (m) => orgFor(m)],
  ];

  return (
    <div>
      <div className="dir-toolbar">
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter members…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {members?.length ?? 0} shown</span>
          <FilterButton groups={facetGroups} state={facets} onChange={setFacets} />
          <ColumnsButton columns={COLUMNS} visible={visibleCols} onChange={setVisibleCols} />
          <ExportButton onExport={() => exportCsv('members', CSV_COLUMNS, visible)} />
        </div>
      </div>

      <div className="dir-list">
        <div className="list-head" style={grid}>
          <button className="sortable" onClick={() => toggleSort('name')}>Member {caret('name')}</button>
          {shownCols.map((c) => (
            <button key={c.key} className="sortable"
                    onClick={() => toggleSort(c.key as SortKey)}>
              {c.label} {caret(c.key as SortKey)}
            </button>
          ))}
          <span>Role</span>
          <span />
        </div>

        {error && <div className="dir-empty"><b>Cannot load members</b>{error}</div>}
        {!error && members && visible.length === 0 && (
          <div className="dir-empty"><b>No matches</b>Try a different search or filter.</div>
        )}

        {visible.map((m) => {
          const isSelf = m.person_id === selfId;
          const disabled = !canEdit || !canTouchRank(maxRank, m.max_rank) || isSelf
            || rowBusy[m.person_id];
          return (
            <div key={m.person_id} className="dir-row">
              <div className="row-main" style={grid}>
                <div className="cell cell-primary">
                  <div className="dir-avatar"
                       style={{ background: m.avatar_url ? 'var(--surface-2)' : avatarGradient(m.display_name) }}>
                    {m.avatar_url ? <img src={m.avatar_url} alt="" /> : initials(m.display_name)}
                  </div>
                  <div className="pn">
                    <b>{m.display_name} {isSelf && <span className="chip tag">you</span>}</b>
                    <span>{m.login_email ?? '—'}</span>
                  </div>
                </div>
                {shownCols.map((c) => (
                  <div className="cell" key={c.key}>{cellFor(m, c.key)}</div>
                ))}
                <div className="cell">
                  {/* Native <select>, not the shared ComboBox: a handful of
                      fixed global roles, and its popup can't be clipped by
                      .dir-list's overflow:hidden the way an absolutely
                      positioned combo-menu would be. */}
                  <select className="org-select" disabled={disabled}
                          value={currentGlobalRole(m)}
                          onChange={(e) => void changeRole(m, e.target.value)}>
                    <option value="">No global role</option>
                    {roleOptionsFor(m).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  {rowError[m.person_id] && (
                    <span className="pf-error" style={{ display: 'block', marginTop: 4 }}>
                      {rowError[m.person_id]}
                    </span>
                  )}
                </div>
                <div className="cell">
                  <button className="mini-btn" onClick={() => setEditingOverridesFor(m)}>
                    Overrides
                    {(overrideCounts[m.person_id] ?? 0) > 0 && ` (${overrideCounts[m.person_id]})`}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {editingOverridesFor && (
        <OverrideEditor
          summary={summary}
          member={editingOverridesFor}
          canEdit={canEdit}
          maxRank={maxRank}
          selfId={selfId}
          onClose={() => setEditingOverridesFor(null)}
          onLoaded={(count) => setOverrideCounts((c) => ({ ...c, [editingOverridesFor.person_id]: count }))}
          onSaved={() => { setEditingOverridesFor(null); onChanged(); }}
        />
      )}
    </div>
  );
}
