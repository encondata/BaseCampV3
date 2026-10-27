/**
 * Learning dashboard (/learning): completion across every move, initiatives
 * at risk (with a Remind button for learning:change, which confirms and
 * sends the reminder email: codes and sessions are kept), what expires in
 * the next 30 days, and the
 * Export button for the compliance report. One fetch per range (7 / 30 / 90
 * days); a stale response never overwrites a newer one.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import ConfirmNewCodesModal from '../../components/learning/ConfirmNewCodesModal';
import { REMIND_NOTE, remindText } from '../../components/learning/initiativeLearning';
import { useLearningAccess } from '../../components/learning/useLearningAccess';
import { useToast } from '../../lib/notificationsContext';
import {
  exportLearningCompliance, formatMedianHours, getLearningDashboard,
  languageName, remindInitiative, startsInText,
  type DashboardDays, type LearningDashboard as Dashboard,
} from '../../lib/learning';
import { parseApiDay } from '../../lib/timeline';
import '../../styles/directory.css';
import '../../styles/dashboard.css';
import '../../styles/learning.css';

const RANGES: { days: DashboardDays; label: string; phrase: string }[] = [
  { days: 7, label: '7 days', phrase: 'last 7 days' },
  { days: 30, label: '30 days', phrase: 'last 30 days' },
  { days: 90, label: 'Quarter', phrase: 'last quarter' },
];

const nf = new Intl.NumberFormat();
const skel = <span className="dash-skel" aria-label="loading" />;
const plural = (n: number, one: string, many = `${one}s`) => `${nf.format(n)} ${n === 1 ? one : many}`;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const shortDate = (iso: string) =>
  parseApiDay(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
const errorText = (err: unknown) => (err instanceof Error && err.message ? err.message : 'Something went wrong.');

function Tile({ label, value, valueClass, bar, barColor, sub }: {
  label: string; value: ReactNode; valueClass?: string; bar: number; barColor: string; sub: ReactNode;
}) {
  return (
    <div className="dash-kpi">
      <span className="dash-kpi-label">{label}</span>
      <span className={`dash-kpi-value ${valueClass ?? ''}`}>{value}</span>
      <span className="lrn-funnel" aria-hidden="true">
        <span style={{ width: `${Math.min(100, bar)}%`, '--lrn-bar': barColor } as CSSProperties} />
      </span>
      <span className="dash-kpi-sub">{sub}</span>
    </div>
  );
}

export default function LearningDashboard() {
  const toast = useToast();
  const canChange = useLearningAccess()('change');
  const [days, setDays] = useState<DashboardDays>(30);
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [reminding, setReminding] = useState<{ id: string; name: string; count: number } | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async (range: DashboardDays) => {
    const id = ++requestId.current;
    try {
      const next = await getLearningDashboard(range);
      if (id !== requestId.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (id === requestId.current) setError(errorText(err));
    }
  }, []);

  useEffect(() => { void load(days); }, [days, load]);

  const pickRange = (range: DashboardDays) => {
    if (range === days) return;
    setData(null);
    setError(null);
    setDays(range);
  };

  const exportReport = async () => {
    setExporting(true);
    try {
      await exportLearningCompliance();
      toast("We'll let you know when it's ready");
    } catch (err) {
      toast(`Couldn't start the report: ${errorText(err)}`);
    } finally {
      setExporting(false);
    }
  };

  /** The reminder email to everyone unfinished on the initiative (the API
   *  picks them; nobody's code changes). Throws on failure: the confirm
   *  dialog shows it and stays open. */
  const remind = async (initiativeId: string, name: string) => {
    const result = await remindInitiative(initiativeId);
    toast(`${remindText(result)} on ${name}`);
    setReminding(null);
    void load(days);
  };

  const range = RANGES.find((r) => r.days === days)!;
  const funnel = data?.funnel;
  const openMedian = funnel ? formatMedianHours(funnel.median_open_hours) : null;
  const finishMedian = funnel?.median_finish_minutes != null
    ? `${Math.round(funnel.median_finish_minutes)} min` : null;
  const expiringEmpty = data !== null && data.expiring.length === 0
    && data.translation_issues.length === 0 && data.hard_questions.length === 0;

  return (
    <div className="portal-page">
      <div className="eyebrow">Learning</div>
      <div className="dash-head">
        <div>
          <h1 className="page-title">Learning</h1>
          <p className="page-hint">All initiatives · {range.phrase}</p>
        </div>
        <div className="dash-ctrls">
          <div className="segmented" role="tablist" aria-label="Range">
            {RANGES.map((r) => (
              <button key={r.days} type="button" role="tab" aria-selected={r.days === days}
                      className={r.days === days ? 'on' : ''} onClick={() => pickRange(r.days)}>
                {r.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn-ghost" disabled={exporting}
                  onClick={() => void exportReport()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                 strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
            </svg>
            Export
          </button>
        </div>
      </div>

      {error !== null && (
        <div className="dash-panel-empty lrn-error" role="alert">
          <span>Couldn&apos;t load the dashboard: {error}</span>
          <button type="button" className="mini-btn" onClick={() => void load(days)}>Try again</button>
        </div>
      )}

      {error === null && (
        <div className="dash-grid">
          <div className="dash-kpis dash-rise">
            <Tile label="Workers assigned" value={funnel ? nf.format(funnel.assigned) : skel}
                  bar={100} barColor="var(--c-slate)"
                  sub={funnel ? 'Everyone with training assigned' : null} />
            <Tile label="Opened invite" value={funnel ? nf.format(funnel.opened) : skel}
                  bar={funnel ? pct(funnel.opened, funnel.assigned) : 0} barColor="var(--c-blue)"
                  sub={funnel ? `${pct(funnel.opened, funnel.assigned)}%${openMedian ? ` · median ${openMedian} after send` : ''}` : null} />
            <Tile label="Fully signed off" value={funnel ? nf.format(funnel.complete) : skel}
                  valueClass="lrn-green"
                  bar={funnel ? pct(funnel.complete, funnel.assigned) : 0} barColor="var(--c-green)"
                  sub={funnel ? `${pct(funnel.complete, funnel.assigned)}%${finishMedian ? ` · median ${finishMedian} to finish` : ''}` : null} />
            <Tile label="Time clock overrides"
                  value={data ? nf.format(data.overrides.count) : skel} valueClass="lrn-amber"
                  bar={data && funnel ? pct(data.overrides.count, funnel.assigned) : 0}
                  barColor="var(--amber)"
                  sub={data ? (data.overrides.count === 0
                    ? 'None in this range'
                    : `By ${plural(data.overrides.admins, 'admin')}`) : null} />
          </div>

          <section className="dash-panel dash-span-6 dash-rise" aria-label="Initiatives at risk">
            <div className="dash-panel-head">
              <span className="dash-panel-title">Initiatives at risk</span>
            </div>
            {data === null && <div className="dash-panel-empty">Loading…</div>}
            {data !== null && data.at_risk.length === 0 && (
              <div className="dash-panel-empty">No initiatives at risk.</div>
            )}
            {data !== null && data.at_risk.length > 0 && (
              <div className="mini-list">
                {data.at_risk.map((i) => {
                  const toRemind = Math.max(0, i.not_finished - i.no_email);
                  const facts = [startsInText(i.starts_in_days)];
                  if (i.not_finished > 0) facts.push(`${nf.format(i.not_finished)} not finished`);
                  if (i.no_email > 0) facts.push(`${nf.format(i.no_email)} no email`);
                  return (
                    <div key={i.initiative_id} className="mini-row flex lrn-risk">
                      <span className="lrn-ring" style={{ '--lrn-pct': i.percent } as CSSProperties}>
                        <span className="lrn-ring-pct">{i.percent}%</span>
                      </span>
                      <div className="lrn-risk-text">
                        <Link className="cell-top" to={`/initiatives/${i.initiative_id}`}>{i.name}</Link>
                        <span className="cell-sub">{facts.join(' · ')}</span>
                      </div>
                      {toRemind > 0 && canChange ? (
                        <button type="button" className="mini-btn accent"
                                onClick={() => setReminding({
                                  id: i.initiative_id, name: i.name, count: toRemind,
                                })}>
                          Remind {toRemind}
                        </button>
                      ) : (
                        <Link className="mini-btn" to={`/initiatives/${i.initiative_id}`}>Open</Link>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="dash-panel dash-span-6 dash-rise" aria-label="Expiring in the next 30 days">
            <div className="dash-panel-head">
              <span className="dash-panel-title">Expiring in the next 30 days</span>
            </div>
            {data === null && <div className="dash-panel-empty">Loading…</div>}
            {expiringEmpty && <div className="dash-panel-empty">Nothing expiring in the next 30 days.</div>}
            {data !== null && !expiringEmpty && (
              <div className="mini-list">
                {data.expiring.map((e) => (
                  <div key={`e-${e.document_id}`} className="mini-row lrn-exp-row">
                    <span className="cell-top">{e.title}</span>
                    <span className="cell-sub">{plural(e.people, 'worker')}</span>
                    <span className="chip c-amber">{shortDate(e.first_date)}</span>
                  </div>
                ))}
                {data.translation_issues.map((t) => (
                  <div key={`t-${t.document_id}-${t.language}`} className="mini-row lrn-exp-row">
                    <span className="cell-top">{languageName(t.language)} translation, {t.title}</span>
                    <span className="cell-sub">Out of date</span>
                    <span className="chip c-red">Needs review</span>
                  </div>
                ))}
                {data.hard_questions.map((q) => (
                  <div key={`q-${q.question_id}`} className="mini-row lrn-exp-row">
                    <span className="cell-top">{q.document_title}, a hard question</span>
                    <span className="cell-sub">{q.miss_percent}% miss it</span>
                    <span className="chip c-violet">Rewrite?</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {reminding && (
        <ConfirmNewCodesModal title="Send reminders" confirmLabel="Send reminders"
                              onClose={() => setReminding(null)}
                              description={`${plural(reminding.count, 'person', 'people')} on ${reminding.name} ${reminding.count === 1 ? 'has' : 'have'} training to finish.`}
                              note={REMIND_NOTE}
                              run={() => remind(reminding.id, reminding.name)} />
      )}
    </div>
  );
}
