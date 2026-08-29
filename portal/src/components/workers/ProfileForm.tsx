import { useMemo, useState, type FormEvent } from 'react';

import ComboBox from '../ComboBox';
import { apiFetch, type StatusValue } from '../../lib/api';
import { WORKER_BLACKLIST, type PartnerRef, type WorkerItem, type WorkerLevelDef } from '../../lib/workers';

export default function ProfileForm({ worker, levels, statuses, onDone, onCancel }: {
  worker: WorkerItem;
  levels: WorkerLevelDef[];
  statuses: StatusValue[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [trade, setTrade] = useState(worker.trade ?? '');
  const [level, setLevel] = useState(worker.level ?? '');
  const [partnerId, setPartnerId] = useState(worker.partner?.id ?? '');
  const [partners, setPartners] = useState<PartnerRef[] | null>(null);
  const [status, setStatus] = useState(worker.status);
  const [note, setNote] = useState(worker.status_note ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // listWorkerStatuses() filters to is_active, so a worker sitting on a retired
  // status isn't in it — the select would render blank and read as "no status
  // set". The row already carries its label, so seed the option back from there.
  // Appended last: the server sorts by sort_order, and this is the exception.
  const options = useMemo<{ key: string; label: string }[]>(() => (
    statuses.some((s) => s.key === worker.status)
      ? statuses
      : [...statuses, { key: worker.status, label: worker.status_label }]
  ), [statuses, worker.status, worker.status_label]);

  const loadPartners = async () => {
    if (partners) return;
    const resp = await apiFetch('/partners');
    if (resp.ok) {
      const body = await resp.json() as { id: string; name: string; archived_at: string | null }[];
      setPartners(body.filter((p) => !p.archived_at));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (status === WORKER_BLACKLIST && !note.trim()) {
      setError('Blacklisting requires a reason.');
      return;
    }
    setSaving(true);
    setError('');
    const resp = await apiFetch(`/workers/${worker.person_id}/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trade: trade.trim() || null,
        level: level || null,
        partner_id: partnerId || null,
        status,
        status_note: note.trim() || null,
      }),
    });
    if (!resp.ok) {
      let code = 'unknown';
      try { code = (await resp.json())?.detail?.code ?? code; } catch { /* noop */ }
      setError(code === 'blacklist_requires_note'
        ? 'Blacklisting requires a reason.'
        : code === 'cannot_target_self'
          ? 'You cannot blacklist yourself.'
          : code === 'rank_too_low'
            ? 'Their rank is at or above yours.'
            : 'Could not save — try again.');
      setSaving(false);
      return;
    }
    onDone();
  };

  return (
    <form className="pf-form" onSubmit={submit}>
      <div><label>Trade / specialty</label>
        <input value={trade} onChange={(e) => setTrade(e.target.value)}
               placeholder="Server tech, packer, driver…" /></div>
      <div><label>Level</label>
        <ComboBox
          placeholder="Type to pick a level…"
          value={level}
          clearable
          onChange={setLevel}
          options={levels.map((l) => ({
            value: l.level, label: `${l.level} · ${l.title}`, sub: l.description,
          }))}
        /></div>
      <div><label>Supplying partner (blank = direct hire)</label>
        <ComboBox
          placeholder="Type to search partners…"
          value={partnerId}
          clearable
          onChange={setPartnerId}
          onOpen={() => void loadPartners()}
          options={(partners ?? (worker.partner ? [worker.partner] : []))
            .map((p) => ({ value: p.id, label: p.name }))}
        /></div>
      <div><label>Status</label>
        <select className="org-select" value={status}
                onChange={(e) => setStatus(e.target.value)}>
          {options.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select></div>
      {status === WORKER_BLACKLIST && (
        <div className="full">
          <label>Blacklist reason *</label>
          <input value={note} onChange={(e) => setNote(e.target.value)}
                 placeholder="Why is this worker blocked?" required />
          <p className="pf-error" style={{ marginTop: 6 }}>
            Saving disables their login and signs them out everywhere.
          </p>
        </div>
      )}
      {status !== WORKER_BLACKLIST && worker.status === WORKER_BLACKLIST && (
        <p className="set-note full" style={{ padding: 0, margin: 0 }}>
          Leaving blacklist re-enables their login account.
        </p>
      )}
      <div className="pf-form-actions">
        <button className="btn-solid" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </button>
        <button className="mini-btn" type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        {error && <span className="pf-error">{error}</span>}
      </div>
    </form>
  );
}
