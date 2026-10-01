import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import MatrixTable from '@portal/components/access/MatrixTable';
import { canTouchRank, type Action } from '@portal/lib/access';

import { errorText, getAccessSummary, putRoleMatrix, type AccessSummary } from '../lib/sirdarApi';

type Matrix = Record<string, Record<Action, boolean>>;

export default function Access() {
  const { can, maxRank, roles: myRoles } = useAuth();
  const [summary, setSummary] = useState<AccessSummary | null>(null);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState<Matrix | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(() => {
    getAccessSummary().then((s) => {
      setSummary(s);
      setSelected((cur) => cur || s.roles[0]?.name || '');
    }).catch((e) => setMessage(errorText(e, "Couldn't load roles.")));
  }, []);

  useEffect(load, [load]);

  const role = summary?.roles.find((r) => r.name === selected);
  useEffect(() => { setDraft(role ? structuredClone(role.matrix) : null); }, [role]);
  if (!summary || !role || !draft) return message ? <p className="form-error">{message}</p> : null;

  const holds = myRoles.includes(role.name);
  const editable = can('access', 'change') && canTouchRank(maxRank, role.rank) && !holds && !saving;
  const locked = new Set(summary.resources.filter((r) => r.developer_only && role.name !== 'developer').map((r) => r.id));
  const dirty = JSON.stringify(draft) !== JSON.stringify(role.matrix);

  const toggle = (res: string, action: Action) =>
    setDraft((d) => d && { ...d, [res]: { ...d[res], [action]: !d[res][action] } });
  const toggleColumn = (action: Action) => setDraft((d) => {
    if (!d) return d;
    const open = summary.resources.filter((r) => !locked.has(r.id));
    const allOn = open.every((r) => d[r.id]?.[action]);
    const next = { ...d };
    for (const r of open) {
      if (r.id === 'access' && action === 'view') continue;
      next[r.id] = { ...next[r.id], [action]: !allOn };
    }
    return next;
  });

  const save = async () => {
    setSaving(true);
    setMessage('');
    try {
      await putRoleMatrix(role.name, draft);
      setMessage(`Saved ${role.label}.`);
      load();
    } catch (e) {
      setMessage(errorText(e, "Couldn't save the role."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="portal-page">
      <div className="eyebrow">Administration</div>
      <div className="dir-head">
        <h1>Roles &amp; access</h1>
        <p>What each role can do in Sirdar. Per-person overrides live on each user's page.</p>
      </div>
      <div className="segmented" role="tablist" aria-label="Roles">
        {summary.roles.map((r) => (
          <button key={r.name} type="button" role="tab" aria-selected={r.name === selected}
                  className={r.name === selected ? 'on' : ''} onClick={() => setSelected(r.name)}>
            {r.label} <span className="page-hint">({r.member_count})</span>
          </button>
        ))}
      </div>
      {holds && <p className="page-hint">You hold this role, so you can't change it.</p>}
      {!holds && !canTouchRank(maxRank, role.rank) && <p className="page-hint">This role outranks you.</p>}
      <MatrixTable mode="role" resources={summary.resources} matrix={draft} editable={editable}
                   lockedResources={locked} lockedCells={new Set(['access:view'])}
                   onToggle={toggle} onToggleColumn={toggleColumn} />
      {message && <p className="page-hint" role="status">{message}</p>}
      {editable && (
        <div className="sirdar-actions">
          <button type="button" className="btn-ghost" disabled={!dirty || saving}
                  onClick={() => setDraft(structuredClone(role.matrix))}>Reset</button>
          <button type="button" className="btn-solid" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  );
}
