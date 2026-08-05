/**
 * ExplorerTab — pick any member (or, below the gate-bypass rank, just
 * yourself — the server enforces this too) and see their resolved
 * effective access: roles, groups, scope, and the read-only 3-mode
 * matrix with override/hard-gate sourcing.
 */

import { useEffect, useMemo, useState } from 'react';

import { ACTIONS } from '../../lib/access';
import {
  ApiError, getEffective, listClients, listPartners, listUsers,
  type AccessSummary, type EffectiveOut, type OrgRef, type UserSummary,
} from '../../lib/api';
import { avatarGradient, initials } from '../../lib/format';
import ComboBox from '../ComboBox';
import MatrixTable from './MatrixTable';

interface Props {
  summary: AccessSummary;
  canEdit: boolean;
  maxRank: number;
  selfId: string;
}

/** Mirrors the server's GATE_BYPASS_RANK: below this, /access/effective/{id}
 *  rejects any id but your own with `not_your_record`, so the picker is
 *  locked client-side to match (belt + suspenders, not the source of truth). */
const LOCKED_PICKER_RANK = 60;

const ERRORS: Record<string, string> = {
  not_your_record: 'You can only explore your own effective access.',
  person_not_found: 'That member no longer exists — refresh and try again.',
};

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? (ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — could not load effective access.';

export default function ExplorerTab({ summary, maxRank, selfId }: Props) {
  const locked = maxRank < LOCKED_PICKER_RANK;

  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [personId, setPersonId] = useState(selfId);
  const [effective, setEffective] = useState<EffectiveOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!locked) listUsers().then(setUsers).catch(() => setUsers([]));
    Promise.all([listClients(), listPartners()])
      .then(([clients, partners]) => setOrgs([...clients, ...partners]))
      .catch(() => setOrgs([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    getEffective(personId)
      .then((eff) => { if (!cancelled) setEffective(eff); })
      .catch((err) => { if (!cancelled) setError(msgFor(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [personId]);

  const options = useMemo(() => (users ?? []).map((u) => ({
    value: u.person_id, label: u.display_name, sub: u.login_email,
  })), [users]);

  const orgName = (id: string) => orgs.find((o) => o.id === id)?.name ?? id;

  const scopeLine = (): string => {
    if (!effective) return '';
    const { scope } = effective;
    if (scope.global) return 'Sees: everything';
    const ids = [...scope.client_ids, ...scope.partner_ids];
    if (ids.length > 0) return `Sees: ${ids.map(orgName).join(', ')} only`;
    return 'Sees: own records only';
  };

  const { n, m } = useMemo(() => {
    if (!effective) return { n: 0, m: 0 };
    let allowed = 0;
    let total = 0;
    for (const res of summary.resources) {
      for (const a of ACTIONS) {
        total += 1;
        if (effective.cells[res.id]?.[a]?.value === true) allowed += 1;
      }
    }
    return { n: allowed, m: total };
  }, [effective, summary.resources]);

  return (
    <div>
      <div className="tab-picker">
        <ComboBox
          options={options}
          value={personId}
          placeholder={locked ? 'Locked to your own access' : 'Type a name…'}
          disabled={locked}
          onChange={(id) => setPersonId(id || selfId)}
        />
      </div>

      {error && <div className="access-empty"><b>Cannot load effective access</b>{error}</div>}
      {loading && !error && <p className="set-note" style={{ padding: 0 }}>Loading…</p>}

      {!loading && !error && effective && (
        <>
          <div className="exp-head">
            <span className="exp-av" style={{ background: avatarGradient(effective.display_name) }}>
              {initials(effective.display_name)}
            </span>
            <div>
              <div className="exp-name">
                {effective.display_name}{' '}
                {effective.person_id === selfId && <span className="chip tag">you</span>}
              </div>
              <div className="chips" style={{ marginTop: 4 }}>
                {effective.roles.length === 0 && <span className="chip tag">no roles</span>}
                {effective.roles.map((r) => (
                  <span key={r} className="chip tag">
                    {summary.roles.find((sr) => sr.name === r)?.label ?? r}
                  </span>
                ))}
              </div>
              <div className="exp-scope">{scopeLine()}</div>
              <div className="chips" style={{ marginTop: 6 }}>
                {effective.groups.length === 0
                  ? <span className="rd-note">Not in any access group</span>
                  : effective.groups.map((g) => (
                    <span key={g.id} className="chip c-violet">{g.name}</span>
                  ))}
              </div>
            </div>
            <div className="exp-perm-count">
              <b>{n} of {m}</b>
              permissions
            </div>
          </div>

          <MatrixTable
            mode="effective"
            resources={summary.resources}
            cells={effective.cells}
            editable={false}
          />
        </>
      )}
    </div>
  );
}
