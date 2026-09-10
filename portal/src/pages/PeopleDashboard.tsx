/**
 * People Dashboard — desk-density view of the workforce right now:
 * clocked-in KPIs, a debounced walk-by rail of badge reads, live
 * on-the-clock rows, 14-day hours, and a timeclock event feed.
 * Refresh idiom mirrors MoveDashboard (interval select; ticks never
 * blank loaded panels). Panels gate on their own resources (Home.tsx
 * style); avatars degrade to the initials gradient.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import {
  getPeopleFlow, getTimeStatsSummary, listActiveTimeEntries, listTimeEntries, listWorkers,
  type PeopleFlowEvent, type PeopleFlowOut, type TimeEntryItem, type TimeStatsSummary,
} from '../lib/api';
import type { WorkerItem } from '../lib/workers';
import { buildTimeclockEvents, hoursDayPoints } from '../lib/peopleDashboard';
import { avatarGradient, initials, relativeTime } from '../lib/format';
import { elapsedSince, formatMinutes } from '../lib/timeFormat';
import { DailyBars } from '../components/dashboard/charts';
import '../styles/directory.css';
import '../styles/dashboard.css';
import '../styles/time.css';

const REFRESH_OPTIONS: { label: string; seconds: number }[] = [
  { label: 'Off', seconds: 0 },
  { label: '15s', seconds: 15 },
  { label: '30s', seconds: 30 },
  { label: '60s', seconds: 60 },
  { label: '5 min', seconds: 300 },
  { label: '15 min', seconds: 900 },
];
const MISSED_PUNCH_MINUTES = 720; // 12h — same rule/copy as TimeManagement
const nf = new Intl.NumberFormat();
const skel = <span className="dash-skel" aria-label="loading" />;

function fmtClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Horizontally-scrolling rail of badge-read cards, newest first (the
 *  server already orders `events` that way). Nudge buttons only show up
 *  once the rail actually overflows its box — a ResizeObserver on the
 *  scroller keeps `fits` current across window resizes and content
 *  changes (jsdom has no ResizeObserver, so tests stub a no-op one). */
function WalkByRail({ events }: { events: PeopleFlowEvent[] }) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [fits, setFits] = useState(true);

  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const check = () => setFits(el.scrollWidth <= el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [events]);

  const nudge = (dir: 1 | -1) =>
    railRef.current?.scrollBy({ left: dir * 320, behavior: 'smooth' });

  return (
    <div className="pdash-rail-wrap">
      {!fits && (
        <button type="button" className="mini-btn pdash-rail-nudge left"
                aria-label="Scroll walk-bys left" onClick={() => nudge(-1)}>‹</button>
      )}
      <div className="pdash-rail" ref={railRef}>
        {events.map((e) => (
          <Link key={`${e.person_id}|${e.device_id}|${e.scanned_at}`}
                className="pdash-flow-card dash-rise" title={e.display_name}
                to={`/people/users?open=${encodeURIComponent(e.person_id)}`}>
            <div className="dir-avatar pdash-flow-avatar"
                 style={{ background: e.avatar_url ? 'var(--surface-2)' : avatarGradient(e.display_name) }}>
              {e.avatar_url ? <img src={e.avatar_url} alt="" /> : initials(e.display_name)}
            </div>
            <div className="pdash-flow-name">{e.display_name.split(/\s+/)[0]}</div>
            <span className="chip tag">{e.device_id || 'reader'}</span>
            <div className="pdash-flow-time">{relativeTime(e.scanned_at)}</div>
          </Link>
        ))}
      </div>
      {!fits && (
        <button type="button" className="mini-btn pdash-rail-nudge right"
                aria-label="Scroll walk-bys right" onClick={() => nudge(1)}>›</button>
      )}
    </div>
  );
}

export default function PeopleDashboard() {
  const { can } = useAuth();
  const canTime = can('time', 'view');
  const canScans = can('scans', 'view');
  const canWorkers = can('workers', 'view');

  const [summary, setSummary] = useState<TimeStatsSummary | null>(null);
  const [flow, setFlow] = useState<PeopleFlowOut | null>(null);
  const [active, setActive] = useState<TimeEntryItem[] | null>(null);
  const [entries, setEntries] = useState<TimeEntryItem[] | null>(null);
  const [workers, setWorkers] = useState<WorkerItem[]>([]);
  const [refreshSec, setRefreshSec] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const refreshAll = useCallback(() => {
    const quiet = () => undefined; // a failed fetch keeps the last data
    const jobs: Promise<unknown>[] = [];
    if (canTime) {
      jobs.push(getTimeStatsSummary().then(setSummary).catch(quiet));
      jobs.push(listActiveTimeEntries().then(setActive).catch(quiet));
      jobs.push(listTimeEntries({ limit: 40 }).then(setEntries).catch(quiet));
    }
    if (canScans) jobs.push(getPeopleFlow().then(setFlow).catch(quiet));
    if (canWorkers) jobs.push(listWorkers().then(setWorkers).catch(quiet));
    if (jobs.length) {
      void Promise.allSettled(jobs).then(() => setUpdatedAt(new Date()));
    }
  }, [canTime, canScans, canWorkers]);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  useEffect(() => {
    if (!refreshSec) return;
    const t = setInterval(refreshAll, refreshSec * 1000);
    return () => clearInterval(t);
  }, [refreshSec, refreshAll]);

  const [, setTick] = useState(0); // 30s live-elapsed tick
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const avatarByPerson = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workers) if (w.avatar_url) m.set(w.person_id, w.avatar_url);
    return m;
  }, [workers]);
  const events = useMemo(() => buildTimeclockEvents(entries ?? [], 20), [entries]);
  const hoursDays = useMemo(() => hoursDayPoints(summary?.days ?? []), [summary]);
  const hoursAllZero = hoursDays.every((d) => d.value === 0);

  /* ── render ──────────────────────────────────────────────── */

  return (
    <div className="portal-page">
      <div className="eyebrow">Dashboards</div>
      <div className="dash-head">
        <h1 className="page-title">People Dashboard</h1>
        <div className="dash-ctrls">
          <label className="dash-ctrl">
            <span>Auto-refresh</span>
            <select aria-label="Auto-refresh" value={refreshSec}
                    onChange={(e) => setRefreshSec(Number(e.target.value))}>
              {REFRESH_OPTIONS.map((o) => (
                <option key={o.seconds} value={o.seconds}>{o.label}</option>
              ))}
            </select>
          </label>
          {updatedAt && (
            <span className="dash-asof">
              {refreshSec > 0 && <span className="dash-asof-dot" aria-hidden="true" />}
              updated {updatedAt.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {!canTime && !canScans && (
        <div className="dash-panel-empty">Nothing your permissions can show here yet.</div>
      )}

      {(canTime || canScans) && (
        <div className="dash-grid">
          {/* ── KPI strip ── */}
          <div className="dash-kpis dash-rise">
            {canTime && (
              <Link to="/people/time" className="dash-kpi">
                <span className="dash-kpi-label">Clocked in now</span>
                <span className="dash-kpi-value">{summary ? nf.format(summary.clocked_in) : skel}</span>
              </Link>
            )}
            {canTime && (
              <div className="dash-kpi">
                <span className="dash-kpi-label">Hours today</span>
                <span className="dash-kpi-value">
                  {summary ? formatMinutes(summary.minutes_today) : skel}
                </span>
              </div>
            )}
            {canTime && (
              <Link to="/people/time" className="dash-kpi">
                <span className="dash-kpi-label">Pending approvals</span>
                <span className="dash-kpi-value">
                  {summary ? nf.format(summary.pending_entries) : skel}
                </span>
              </Link>
            )}
            {canScans && (
              <div className="dash-kpi">
                <span className="dash-kpi-label">On site today</span>
                <span className="dash-kpi-value">
                  {flow ? nf.format(flow.distinct_people_today) : skel}
                </span>
              </div>
            )}
            {canScans && (
              <div className="dash-kpi">
                <span className="dash-kpi-label">Badge scans today</span>
                <span className="dash-kpi-value">
                  {flow ? nf.format(flow.person_scans_today) : skel}
                </span>
              </div>
            )}
          </div>

          {/* ── walk-by rail ── */}
          {canScans && (
            <section className="dash-panel dash-span-12 dash-rise" aria-label="Reader walk-bys">
              <div className="dash-panel-head">
                <span className="dash-panel-title">Reader walk-bys</span>
                <Link className="dash-panel-link" to="/admin/scans">All scans</Link>
              </div>
              {flow === null && <div className="dash-panel-empty">Loading…</div>}
              {flow !== null && flow.events.length === 0 && (
                <div className="dash-panel-empty">No badge reads yet today.</div>
              )}
              {flow !== null && flow.events.length > 0 && <WalkByRail events={flow.events} />}
            </section>
          )}

          {/* ── on the clock now ── */}
          {canTime && (
            <section className="dash-panel dash-span-7 dash-rise" aria-label="On the clock now">
              <div className="dash-panel-head">
                <span className="dash-panel-title">On the clock now</span>
                <Link className="dash-panel-link" to="/people/time">Time Management</Link>
              </div>
              {active === null && <div className="dash-panel-empty">Loading…</div>}
              {active !== null && active.length === 0 && (
                <div className="dash-panel-empty">Nobody is clocked in.</div>
              )}
              {active !== null && active.length > 0 && (
                <div className="mini-list pdash-clock-list">
                  {active.map((e) => {
                    const mins = elapsedSince(e.clock_in_at);
                    const avatarUrl = avatarByPerson.get(e.person_id) ?? null;
                    const context = e.initiative_name ?? e.site_name ?? null;
                    return (
                      <div key={e.id} className="mini-row pdash-clock-row">
                        <div className="dir-avatar"
                             style={{ background: avatarUrl ? 'var(--surface-2)' : avatarGradient(e.person_name) }}>
                          {avatarUrl ? <img src={avatarUrl} alt="" /> : initials(e.person_name)}
                        </div>
                        <div className="cell-primary">
                          <div className="pn">
                            <Link className="pdash-clock-name" to={`/people/workers/${e.person_id}`}>
                              <b>{e.person_name}</b>
                            </Link>
                            <span>since {fmtClockTime(e.clock_in_at)}</span>
                          </div>
                        </div>
                        {context && <span className="chip tag">{context}</span>}
                        <span className="pdash-clock-elapsed mono">{formatMinutes(mins)}</span>
                        {mins >= MISSED_PUNCH_MINUTES && (
                          <span className="chip tag time-flag">12h+ — missed punch?</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* ── hours logged ── */}
          {canTime && (
            <section className="dash-panel dash-span-5 dash-rise" aria-label="Hours logged — 14 days">
              <div className="dash-panel-head">
                <span className="dash-panel-title">Hours logged — 14 days</span>
              </div>
              {summary === null && <div className="dash-panel-empty">Loading…</div>}
              {summary !== null && hoursAllZero && (
                <div className="dash-panel-empty">No time logged in the last 14 days.</div>
              )}
              {summary !== null && !hoursAllZero && (
                <DailyBars days={hoursDays} ariaLabel="Hours logged per day"
                           formatTooltip={(d) => `${d.label}: ${formatMinutes(d.value)}`} />
              )}
            </section>
          )}

          {/* ── latest timeclock events ── */}
          {canTime && (
            <section className="dash-panel dash-span-12 dash-rise" aria-label="Latest timeclock events">
              <div className="dash-panel-head">
                <span className="dash-panel-title">Latest timeclock events</span>
              </div>
              {entries === null && <div className="dash-panel-empty">Loading…</div>}
              {entries !== null && events.length === 0 && (
                <div className="dash-panel-empty">No timeclock activity yet.</div>
              )}
              {entries !== null && events.length > 0 && (
                <div className="mini-list pdash-event-list">
                  {events.map((ev) => (
                    <Link key={ev.key} className="mini-row pdash-event-row" to="/people/time">
                      <span className="pdash-event-dot"
                            style={{ background: ev.kind === 'in' ? '#178a4c' : '#51606f' }}
                            aria-hidden="true" />
                      <b className="cell-top">{ev.person_name}</b>
                      <span className="cell-sub">
                        {ev.kind === 'in' ? 'clocked in' : `clocked out · ${formatMinutes(ev.minutes ?? 0)}`}
                      </span>
                      {ev.context && <span className="chip tag">{ev.context}</span>}
                      <span className="pdash-event-time mono">{relativeTime(ev.at)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
