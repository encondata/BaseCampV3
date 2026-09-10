import { useEffect, useState, type FormEvent } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { apiFetch } from '../../lib/api';
import { longDate } from '../../lib/format';

interface Cert {
  id: string;
  name: string;
  issuer: string | null;
  issued_on: string | null;
  expires_on: string | null;
}

function certState(c: Cert): { label: string; cls: string } | null {
  if (!c.expires_on) return null;
  const days = (new Date(c.expires_on).getTime() - Date.now()) / 86_400_000;
  if (days < 0) return { label: 'expired', cls: 'c-red' };
  if (days < 30) return { label: 'expiring', cls: 'c-amber' };
  return null;
}

export default function CertsPanel({ personId, onChanged }: {
  personId: string;
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const canAdd = can('workers', 'add');
  const canDelete = can('workers', 'delete');
  const [certs, setCerts] = useState<Cert[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', issuer: '', issued_on: '', expires_on: '' });
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const resp = await apiFetch(`/workers/${personId}/certifications`);
    if (resp.ok) setCerts(await resp.json());
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [personId]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await apiFetch(`/workers/${personId}/certifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.name.trim(),
        issuer: form.issuer.trim() || null,
        issued_on: form.issued_on || null,
        expires_on: form.expires_on || null,
      }),
    });
    setForm({ name: '', issuer: '', issued_on: '', expires_on: '' });
    setAdding(false);
    await refresh();
    onChanged();
    setBusy(false);
  };

  const remove = async (certId: string) => {
    setBusy(true);
    await apiFetch(`/workers/${personId}/certifications/${certId}`, { method: 'DELETE' });
    await refresh();
    onChanged();
    setBusy(false);
  };

  return (
    <>
      {certs === null && <p className="set-note" style={{ padding: 0 }}>Loading…</p>}
      {certs?.length === 0 && !adding && (
        <p className="set-note" style={{ padding: 0 }}>No certifications on file.</p>
      )}
      {certs?.map((c) => {
        const state = certState(c);
        return (
          <div className="session-item" key={c.id}>
            <div className="session-main cell">
              <div className="cell-top"><b>{c.name}</b></div>
              <div className="cell-sub mono">
                {[c.issuer,
                  c.issued_on ? `issued ${longDate(c.issued_on)}` : null,
                  c.expires_on ? `expires ${longDate(c.expires_on)}` : 'no expiry',
                ].filter(Boolean).join(' · ')}
              </div>
            </div>
            {state && (
              <span className={`chip ${state.cls}`}><span className="dot" />{state.label}</span>
            )}
            {canDelete && (
              <button className="mini-btn" disabled={busy} title="Remove"
                      onClick={() => void remove(c.id)}>✕</button>
            )}
          </div>
        );
      })}

      {canAdd && !adding && (
        <div className="detail-actions">
          <button className="mini-btn accent" onClick={() => setAdding(true)}>
            + Add certification
          </button>
        </div>
      )}
      {adding && (
        <form className="pf-form" onSubmit={add} style={{ marginTop: 14 }}>
          <div><label>Name *</label>
            <input value={form.name} required autoFocus
                   placeholder="OSHA 30, background check…"
                   onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label>Issuer</label>
            <input value={form.issuer}
                   onChange={(e) => setForm({ ...form, issuer: e.target.value })} /></div>
          <div><label>Issued</label>
            <input type="date" value={form.issued_on}
                   onChange={(e) => setForm({ ...form, issued_on: e.target.value })} /></div>
          <div><label>Expires</label>
            <input type="date" value={form.expires_on}
                   onChange={(e) => setForm({ ...form, expires_on: e.target.value })} /></div>
          <div className="pf-form-actions">
            <button className="btn-solid" type="submit" disabled={busy || !form.name.trim()}>
              Add
            </button>
            <button className="mini-btn" type="button" disabled={busy}
                    onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </>
  );
}
