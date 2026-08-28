/**
 * Worker Details — full read view of a single worker: profile, certifications,
 * and (permission-gated) recent time entries. Chrome mirrors AssetDetail
 * (idet- classes, init-panel cards, kv dl lists). There is no single-worker
 * GET, so the data source is the same roster list Workers.tsx renders —
 * this page loads it and finds its row by person_id, mirroring how
 * MoveAssetDetail reads its row off a list rather than a dedicated endpoint.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import StatusHover from '../components/StatusHover';
import {
  listTimeEntries, listWorkerCertifications, listWorkerLevels, listWorkers,
  type CertItem, type TimeEntryItem, type WorkerLevel,
} from '../lib/api';
import { longDate } from '../lib/format';
import { formatMinutes } from '../lib/timeFormat';
import type { WorkerItem } from '../lib/workers';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/profile.css';
import '../styles/settings.css';
import '../styles/time.css';

const chip = (label: string, color: string) => (
  <span className="chip custom" style={{ '--chip': color } as CSSProperties}>
    <span className="dot" />{label}
  </span>
);

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function isExpired(c: CertItem): boolean {
  return !!c.expires_on && new Date(c.expires_on).getTime() < Date.now();
}

export default function WorkerDetail() {
  const { personId } = useParams<{ personId: string }>();
  const { can } = useAuth();
  const canViewTime = can('time');

  const [worker, setWorker] = useState<WorkerItem | null>(null);
  const [missing, setMissing] = useState(false);
  const [levels, setLevels] = useState<WorkerLevel[]>([]);
  const [certs, setCerts] = useState<CertItem[] | null>(null);
  const [entries, setEntries] = useState<TimeEntryItem[] | null>(null);

  const load = useCallback(async () => {
    if (!personId) return;
    try {
      const workers = await listWorkers();
      const found = workers.find((w) => w.person_id === personId) ?? null;
      setWorker(found);
      setMissing(!found);
    } catch {
      setMissing(true);
    }
  }, [personId]);

  useEffect(() => {
    void load();
    void listWorkerLevels().then(setLevels).catch(() => {});
  }, [load]);

  useEffect(() => {
    if (!personId) return;
    void listWorkerCertifications(personId).then(setCerts).catch(() => setCerts([]));
  }, [personId]);

  useEffect(() => {
    if (!personId || !canViewTime) return;
    void listTimeEntries({ person_id: personId, limit: 15 })
      .then(setEntries).catch(() => setEntries([]));
  }, [personId, canViewTime]);

  const back = <Link to="/people/workers" className="idet-back">← Workers</Link>;

  if (missing) {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Worker not found</b>This worker does not exist or was removed.
        </div>
      </div>
    );
  }
  if (!worker) {
    return <div className="portal-page">{back}<p className="page-hint">Loading…</p></div>;
  }

  const levelDef = worker.level ? levels.find((l) => l.level === worker.level) : undefined;
  const levelText = worker.level
    ? (levelDef ? `${worker.level} · ${levelDef.title}` : worker.level)
    : 'Unleveled';

  return (
    <div className="portal-page">
      {back}
      <div className="idet-header">
        <div className="idet-heading">
          <h1 className="page-title">{worker.display_name}</h1>
          <p className="page-hint">
            {[worker.trade, levelDef?.title].filter(Boolean).join(' · ') || '—'}
          </p>
        </div>
        <div className="idet-header-actions">
          <span className="lvl-badge" title={levelDef
            ? `${levelDef.title} — ${levelDef.description}` : undefined}>
            <b style={{ '--lvl': levelDef?.color ?? '#8a93a6' } as CSSProperties}>
              {worker.level ?? '—'}
            </b>
            <span>{levelDef?.title ?? ''}</span>
          </span>
          <StatusHover entityType="worker" entityId={worker.person_id} status={worker.status}>
            {chip(worker.status_label, worker.status_color)}
          </StatusHover>
        </div>
      </div>

      <div className="init-panel">
        <p className="eyebrow-sm">Profile</p>
        <dl className="kv">
          <dt>Trade</dt><dd>{worker.trade ?? '—'}</dd>
          <dt>Level</dt><dd>{levelText}</dd>
          <dt>Partner</dt><dd>{worker.partner?.name ?? 'Direct'}</dd>
          <dt>Status note</dt><dd>{worker.status_note ?? '—'}</dd>
        </dl>
      </div>

      <div className="init-panel">
        <p className="eyebrow-sm">Certifications</p>
        {certs === null && <p className="set-note" style={{ padding: 0 }}>Loading…</p>}
        {certs?.length === 0 && (
          <p className="set-note" style={{ padding: 0 }}>No certifications recorded.</p>
        )}
        {certs?.map((c) => {
          const expired = isExpired(c);
          return (
            <div className="session-item" key={c.id}>
              <div className="session-main">
                <b>{c.name}</b>
                <p style={expired ? { color: 'var(--c-red)' } : undefined}>
                  {[c.issuer, c.expires_on ? `expires ${longDate(c.expires_on)}` : 'no expiry']
                    .filter(Boolean).join(' · ')}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {canViewTime && (
        <div className="init-panel">
          <p className="eyebrow-sm">Recent time entries</p>
          {entries === null && <p className="set-note" style={{ padding: 0 }}>Loading…</p>}
          {entries?.length === 0 && (
            <p className="set-note" style={{ padding: 0 }}>No time entries recorded.</p>
          )}
          {entries !== null && entries.length > 0 && (
            <div className="time-recent-list">
              {entries.map((e) => (
                <div key={e.id} className="time-recent-row">
                  <span className="time-recent-date">{fmtDate(e.clock_in_at)}</span>
                  <span className="time-recent-span">
                    {fmtTime(e.clock_in_at)} → {fmtTime(e.clock_out_at)}
                  </span>
                  <span className="time-recent-duration">{formatMinutes(e.minutes)}</span>
                  <span className="time-recent-initiative">{e.initiative_name ?? '—'}</span>
                  <StatusHover entityType="time_entry" entityId={e.id} status={e.status}>
                    {chip(e.status_label, e.status_color)}
                  </StatusHover>
                </div>
              ))}
            </div>
          )}
          <div className="detail-actions">
            <Link className="mini-btn" to="/people/time">Time Management →</Link>
          </div>
        </div>
      )}
    </div>
  );
}
