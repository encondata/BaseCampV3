/**
 * WorkerDetail — full page for one worker: /me-style hero (photo, chips,
 * contact strip), worker profile + person details editing, level card,
 * certifications, initiative history, import provenance, notes/files.
 * Chrome mirrors Profile.tsx (hero/panels) + SiteDetail.tsx (back link).
 */
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AvatarUpload from '../components/AvatarUpload';
import NotesFilesPanel from '../components/NotesFilesPanel';
import CertsPanel from '../components/workers/CertsPanel';
import LevelBadge from '../components/workers/LevelBadge';
import ProfileForm from '../components/workers/ProfileForm';
import { apiFetch, listWorkerStatuses, type StatusValue } from '../lib/api';
import { longDate } from '../lib/format';
import {
  getWorker, WORKER_BLACKLIST,
  type WorkerDetailItem, type WorkerLevelDef,
} from '../lib/workers';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/profile.css';
import '../styles/settings.css';   // .set-note

const PERSON_FIELDS = [
  { key: 'first_name', label: 'First name', full: false, required: true },
  { key: 'last_name', label: 'Last name', full: false, required: true },
  { key: 'preferred_name', label: 'Preferred name', full: false, required: false },
  { key: 'job_title', label: 'Job title', full: false, required: false },
  { key: 'email', label: 'Contact email', full: false, required: false },
  { key: 'phone', label: 'Phone', full: false, required: false },
  { key: 'address_line1', label: 'Address line 1', full: true, required: false },
  { key: 'address_line2', label: 'Address line 2', full: true, required: false },
  { key: 'city', label: 'City', full: false, required: false },
  { key: 'region', label: 'State / region', full: false, required: false },
  { key: 'postal_code', label: 'Postal code', full: false, required: false },
  { key: 'country', label: 'Country (2-letter)', full: false, required: true },
] as const;
type PersonKey = (typeof PERSON_FIELDS)[number]['key'];

// WorkerDetailItem carries email as contact_email; the PATCH speaks person
// field names — map just that one key.
const valueFor = (w: WorkerDetailItem, key: PersonKey): string =>
  (key === 'email' ? w.contact_email : (w as unknown as Record<string, string | null>)[key]) ?? '';

const chip = (label: string | null, color: string | null) =>
  label ? (
    <span className="chip custom" style={{ '--chip': color ?? '#51606f' } as CSSProperties}>
      <span className="dot" />{label}
    </span>
  ) : null;

export default function WorkerDetailPage() {
  const { personId } = useParams<{ personId: string }>();
  const { can } = useAuth();
  const canManage = can('workers', 'change');

  const [worker, setWorker] = useState<WorkerDetailItem | null>(null);
  const [missing, setMissing] = useState(false);
  const [levels, setLevels] = useState<WorkerLevelDef[]>([]);
  const [statuses, setStatuses] = useState<StatusValue[]>([]);
  const [editingProfile, setEditingProfile] = useState(false);
  const [editingPerson, setEditingPerson] = useState(false);
  const [personForm, setPersonForm] = useState<Record<PersonKey, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [personError, setPersonError] = useState('');

  const load = useCallback(async () => {
    if (!personId) return;
    try {
      setWorker(await getWorker(personId));
      setMissing(false);
    } catch {
      setMissing(true);
    }
  }, [personId]);

  useEffect(() => {
    void load();
    void apiFetch('/worker-levels').then(async (r) => {
      if (r.ok) setLevels(await r.json() as WorkerLevelDef[]);
    }).catch(() => {});
    void listWorkerStatuses().then(setStatuses).catch(() => {});
  }, [load]);

  const startPersonEdit = () => {
    if (!worker) return;
    const form = {} as Record<PersonKey, string>;
    for (const f of PERSON_FIELDS) form[f.key] = valueFor(worker, f.key);
    setPersonForm(form);
    setPersonError('');
    setEditingPerson(true);
  };

  const savePerson = async (e: FormEvent) => {
    e.preventDefault();
    if (!personForm || !worker) return;
    setSaving(true);
    setPersonError('');
    const patch: Record<string, string | null> = {};
    for (const f of PERSON_FIELDS) {
      const now = personForm[f.key].trim();
      if (now !== valueFor(worker, f.key)) patch[f.key] = now === '' ? null : now;
    }
    try {
      if (Object.keys(patch).length > 0) {
        const resp = await apiFetch(`/workers/${worker.person_id}/person`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!resp.ok) {
          let code = 'unknown';
          try { code = (await resp.json())?.detail?.code ?? code; } catch { /* noop */ }
          setPersonError(code === 'rank_too_low'
            ? "You can't edit this person's details — they outrank you."
            : code === 'email_in_use'
              ? 'That contact email is already in use by another person.'
              : 'Could not save — check the fields and try again.');
          return;
        }
      }
      setEditingPerson(false);
      void load();
    } catch {
      setPersonError('Could not save — check the fields and try again.');
    } finally {
      setSaving(false);
    }
  };

  const back = <Link to="/people/workers" className="idet-back">← Workers</Link>;

  if (missing) {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Worker not found</b>This person does not exist, is not a worker, or was removed.
        </div>
      </div>
    );
  }
  if (!worker) {
    return <div className="portal-page">{back}<p className="page-hint">Loading…</p></div>;
  }

  const joined = [worker.city, worker.region].filter(Boolean).join(', ');

  return (
    <div className="portal-page">
      {back}

      <div className="profile-hero">
        <div className="profile-cover" />
        <div className="profile-id">
          <AvatarUpload
            name={worker.display_name}
            url={worker.avatar_url}
            entityType="person"
            entityId={worker.person_id}
            editable={canManage}
            size={104}
            radius={26}
            onUploaded={() => void load()}
          />
          <div className="profile-meta">
            <h1>
              {worker.display_name}
              {chip(worker.status_label, worker.status_color)}
              <LevelBadge level={worker.level} levels={levels} />
            </h1>
            <div className="pm-role">
              {[worker.trade ?? 'No trade set',
                worker.partner?.name ?? 'Direct hire'].join(' · ')}
            </div>
            <div className="pm-sub">
              {worker.contact_email && <span>✉ {worker.contact_email}</span>}
              {worker.phone && <span>☏ {worker.phone}</span>}
              {joined && <span>⌖ {joined}</span>}
              <span>added {longDate(worker.created_at)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="profile-grid">
        <div>
          <div className="panel">
            <div className="panel-head">
              <h3>Worker profile</h3>
              {canManage && !editingProfile && (
                <button className="mini-btn" onClick={() => setEditingProfile(true)}>Edit</button>
              )}
            </div>
            <div className="panel-body">
              {editingProfile ? (
                <ProfileForm worker={worker} levels={levels} statuses={statuses}
                             onDone={() => { setEditingProfile(false); void load(); }}
                             onCancel={() => setEditingProfile(false)} />
              ) : (
                <dl className="kv">
                  <dt>Trade</dt><dd>{worker.trade ?? '—'}</dd>
                  <dt>Level</dt><dd><LevelBadge level={worker.level} levels={levels} /></dd>
                  <dt>Partner</dt><dd>{worker.partner?.name ?? 'Direct hire'}</dd>
                  <dt>Status</dt><dd>{chip(worker.status_label, worker.status_color)}</dd>
                  {worker.status_note && (
                    <><dt>Status note</dt><dd>{worker.status_note}</dd></>
                  )}
                  <dt>Login</dt>
                  <dd>{worker.has_account
                    ? (worker.status === WORKER_BLACKLIST
                      ? <span className="chip c-red"><span className="dot" />disabled (blacklist)</span>
                      : <span className="chip c-green"><span className="dot" />portal access</span>)
                    : <span className="chip tag">no account</span>}</dd>
                </dl>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>{editingPerson ? 'Edit person details' : 'Person details'}</h3>
              {canManage && !editingPerson && (
                <button className="mini-btn" onClick={startPersonEdit}>Edit</button>
              )}
            </div>
            <div className="panel-body">
              {editingPerson && personForm ? (
                <form className="pf-form" onSubmit={savePerson} noValidate>
                  {PERSON_FIELDS.map((f) => (
                    <div key={f.key} className={f.full ? 'full' : ''}>
                      <label htmlFor={`wd-${f.key}`}>{f.label}{f.required ? ' *' : ''}</label>
                      <input id={`wd-${f.key}`} value={personForm[f.key]}
                             required={f.required}
                             onChange={(e) => setPersonForm({ ...personForm, [f.key]: e.target.value })} />
                    </div>
                  ))}
                  <div className="pf-form-actions">
                    <button className="btn-solid" type="submit" disabled={saving}>
                      {saving ? 'Saving…' : 'Save changes'}
                    </button>
                    <button className="mini-btn" type="button" disabled={saving}
                            onClick={() => setEditingPerson(false)}>
                      Cancel
                    </button>
                    {personError && <span className="pf-error">{personError}</span>}
                  </div>
                </form>
              ) : (
                <dl className="kv">
                  <dt>Preferred name</dt><dd>{worker.preferred_name ?? '—'}</dd>
                  <dt>Job title</dt><dd>{worker.job_title ?? '—'}</dd>
                  <dt>Contact email</dt><dd className="mono">{worker.contact_email ?? '—'}</dd>
                  <dt>Phone</dt><dd className="mono">{worker.phone ?? '—'}</dd>
                  <dt>Address</dt>
                  <dd>
                    {[worker.address_line1, worker.address_line2,
                      [worker.city, worker.region, worker.postal_code].filter(Boolean).join(', '),
                      worker.country]
                      .filter((part) => part && String(part).length > 0)
                      .join(' · ') || '—'}
                  </dd>
                  <dt>Badge ID</dt><dd className="mono">{worker.badge_uid}</dd>
                  <dt>RFID tag</dt><dd className="mono">{worker.rfid_tag ?? '—'}</dd>
                  <dt>Added</dt><dd className="mono">{longDate(worker.created_at)}</dd>
                </dl>
              )}
            </div>
          </div>

          {worker.source_ref && (
            <div className="panel">
              <div className="panel-head"><h3>Import provenance</h3></div>
              <div className="panel-body">
                <dl className="kv">
                  <dt>Source</dt><dd>{worker.source}</dd>
                  <dt>Source ref</dt><dd className="mono">{worker.source_ref}</dd>
                </dl>
                {worker.person_notes && (
                  <p className="set-note" style={{ whiteSpace: 'pre-line', padding: '10px 0 0' }}>
                    {worker.person_notes}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div>
          {worker.level_def && (
            <div className="panel">
              <div className="panel-head">
                <h3>{worker.level_def.level} · {worker.level_def.title}</h3>
              </div>
              <div className="panel-body">
                <p className="set-note" style={{ padding: '0 0 8px' }}>
                  {worker.level_def.description}
                </p>
                <div className="chips">
                  {worker.level_def.expected_skills.map((s) => (
                    <span key={s} className="chip c-blue">⚡ {s}</span>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="panel">
            <div className="panel-head">
              <h3>Certifications &amp; compliance</h3>
              <span className="result-count">
                {worker.cert_count} on file{worker.certs_expired > 0
                  ? ` · ${worker.certs_expired} expired` : ''}
              </span>
            </div>
            <div className="panel-body">
              <CertsPanel personId={worker.person_id} onChanged={() => void load()} />
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Initiative history</h3>
              <span className="result-count">{worker.initiatives.length} initiatives</span>
            </div>
            <div className="panel-body">
              {worker.initiatives.length === 0 ? (
                <p className="set-note" style={{ padding: 0 }}>
                  Not on any initiative rosters yet.
                </p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="activity-changes">
                    <thead>
                      <tr>
                        <th>Initiative</th><th>Type</th><th>Status</th>
                        <th>Work type</th><th>Site</th><th>Rating</th><th>Added</th>
                      </tr>
                    </thead>
                    <tbody>
                      {worker.initiatives.map((i) => (
                        <tr key={`${i.initiative_id}-${i.added_at}`}>
                          <td><Link to={`/initiatives/${i.initiative_id}`}>{i.initiative_name}</Link></td>
                          <td>{chip(i.type_label, i.type_color) ?? '—'}</td>
                          <td>{chip(i.status_label, i.status_color)}</td>
                          <td>{chip(i.work_type_label, i.work_type_color) ?? '—'}</td>
                          <td>{i.site_worked_name ?? '—'}</td>
                          <td>{i.rating != null ? `★ ${i.rating}` : '—'}</td>
                          <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                            {new Date(i.added_at).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-body">
              <NotesFilesPanel entityType="person" entityId={worker.person_id}
                               canWrite={canManage} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
