/**
 * An initiative's Learning tab (/initiatives/:id?tab=learning): stat tiles,
 * the invites and reminders card (mini timeline, key/values, Edit
 * schedule), what the initiative requires (packets, extras, Assign,
 * Preview rules), the workers roster, and the compliance grid. Header
 * actions: Compliance report, Print code sheet, Send invites now.
 *
 * Everything here is a Learning-manager call (learning:view reads); each
 * control that changes something follows the API's own action for it —
 * schedule, sends, codes and the code sheet need `change`, manual
 * assignment and applying the rules need `add` — and is left out for
 * anyone without it. A viewer who isn't a manager never gets this tab
 * (InitiativeDetail), because the API refuses every one of its reads.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../../auth/AuthContext';
import {
  exportLearningCompliance, getInitiativeLearning, listInitiativeRoster, regenerateLearningCode,
  sendInitiativeInvites,
  type InitiativeLearning, type RosterRow, type RosterStatus, type SendInvitesResult,
} from '../../lib/learning';
import { useToast } from '../../lib/notificationsContext';
import AssignExtraModal from './AssignExtraModal';
import CodeSheetModal from './CodeSheetModal';
import ComplianceGrid from './ComplianceGrid';
import DryRunPanel from './DryRunPanel';
import {
  dayLabel, dayLabelYear, instantLabel, joinNumbers, plural, tabErrorText, timeLabel,
} from './initiativeLearning';
import LearningModal from './LearningModal';
import LearningRoster, { type RosterFilter } from './LearningRoster';
import LearningTimeline from './LearningTimeline';
import RevokeCodesModal from './RevokeCodesModal';
import ScheduleModal from './ScheduleModal';
import SendInvitesModal from './SendInvitesModal';
import { useLearningAccess } from './useLearningAccess';

const EMPTY_COUNTS: Record<RosterFilter, number> = {
  all: 0, overdue: 0, in_progress: 0, not_opened: 0, complete: 0, no_email: 0,
};

function countsOf(rows: RosterRow[]): Record<RosterFilter, number> {
  const out = { ...EMPTY_COUNTS, all: rows.length };
  rows.forEach((r) => { out[r.status as RosterStatus] += 1; });
  return out;
}

/** "Sent 2 · 1 without email · 1 already invited" for a Resend. */
function sendText(r: SendInvitesResult): string {
  const parts = [`Sent ${r.sent}`];
  if (r.no_email > 0) parts.push(`${r.no_email} without email`);
  if (r.skipped_complete > 0) parts.push(`${r.skipped_complete} already complete`);
  if (r.already_invited > 0) parts.push(`${r.already_invited} already invited`);
  return parts.join(' · ');
}

export default function InitiativeLearningTab({ initiativeId }: { initiativeId: string }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useAuth();
  const allowed = useLearningAccess();
  const canChange = allowed('change');
  const canAdd = allowed('add');
  const canReport = can('reports', 'add');
  const canViewWorker = can('workers', 'view');

  // `version` bumps after anything that can change the numbers
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const [data, setData] = useState<InitiativeLearning | null>(null);
  const [loadError, setLoadError] = useState('');
  const [everyone, setEveryone] = useState<RosterRow[] | null>(null);
  const [filter, setFilter] = useState<RosterFilter>('all');
  const [filtered, setFiltered] = useState<RosterRow[] | null>(null);
  const [filterLoading, setFilterLoading] = useState(false);
  const [rosterFailed, setRosterFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);

  type Dialog = 'send' | 'schedule' | 'sheet' | 'preview' | 'assign' | { revoke: RosterRow } | null;
  const [dialog, setDialog] = useState<Dialog>(null);

  // the summary and the unfiltered roster (counts, who a send reaches)
  const summarySeq = useRef(0);
  useEffect(() => {
    const mine = ++summarySeq.current;
    getInitiativeLearning(initiativeId)
      .then((d) => { if (summarySeq.current === mine) { setData(d); setLoadError(''); } })
      .catch((e) => { if (summarySeq.current === mine) setLoadError(tabErrorText(e)); });
    listInitiativeRoster(initiativeId, undefined)
      .then((rows) => { if (summarySeq.current === mine) { setEveryone(rows); setRosterFailed(false); } })
      .catch(() => { if (summarySeq.current === mine) setRosterFailed(true); });
  }, [initiativeId, version]);

  // a status filter asks the server for just those rows
  const filterSeq = useRef(0);
  useEffect(() => {
    if (filter === 'all') { setFiltered(null); setFilterLoading(false); return; }
    const mine = ++filterSeq.current;
    setFilterLoading(true);
    listInitiativeRoster(initiativeId, filter)
      .then((rows) => { if (filterSeq.current === mine) { setFiltered(rows); setRosterFailed(false); } })
      .catch(() => { if (filterSeq.current === mine) setRosterFailed(true); })
      .finally(() => { if (filterSeq.current === mine) setFilterLoading(false); });
  }, [initiativeId, filter, version]);

  const rows = filter === 'all' ? everyone : filtered;
  const counts = everyone ? countsOf(everyone) : EMPTY_COUNTS;

  const resend = async (personIds: string[]) => {
    setBusyId(personIds.length === 1 ? personIds[0] : '*');
    try {
      toast(sendText(await sendInitiativeInvites(initiativeId, personIds)));
      refresh();
    } catch (e) {
      toast(`Couldn’t resend: ${tabErrorText(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const regenerate = async (row: RosterRow) => {
    setBusyId(row.person_id);
    try {
      await regenerateLearningCode(initiativeId, row.person_id);
      toast(`Sent ${row.name} a new code`);
      refresh();
    } catch (e) {
      toast(tabErrorText(e));
    } finally {
      setBusyId(null);
    }
  };

  const runReport = async () => {
    setReporting(true);
    try {
      await exportLearningCompliance(initiativeId);
      toast('We’ll let you know when the report is ready');
    } catch (e) {
      toast(`Couldn’t start the report: ${tabErrorText(e)}`);
    } finally {
      setReporting(false);
    }
  };

  if (loadError && data === null) {
    return (
      <div className="lrn-initab">
        <div className="dash-panel-empty lrn-error" role="alert">
          <span>Couldn’t load Learning for this initiative: {loadError}</span>
          <button type="button" className="mini-btn" onClick={refresh}>Try again</button>
        </div>
      </div>
    );
  }
  if (data === null) return <div className="lrn-initab"><p className="page-hint">Loading…</p></div>;

  const { stats, schedule } = data;
  const pctOfInvited = (n: number) => (stats.invited > 0 ? Math.round((n / stats.invited) * 100) : 0);
  const due = data.timeline.find((e) => e.kind === 'due');
  const sentLine = schedule.sent_at
    ? `Sent ${instantLabel(schedule.sent_at)}`
    : schedule.mode === 'scheduled' && schedule.send_at
      ? `Goes out ${instantLabel(schedule.send_at)}`
      : 'Not sent yet';
  const tiles: { key: string; label: string; value: number; sub: string; tone?: string; alert?: boolean }[] = [
    { key: 'invited', label: 'Invited', value: stats.invited, sub: sentLine },
    { key: 'opened', label: 'Opened', value: stats.opened, sub: `${pctOfInvited(stats.opened)}% of invited` },
    { key: 'progress', label: 'In progress', value: stats.in_progress, sub: 'Started, not finished' },
    { key: 'complete', label: 'Complete', value: stats.complete, tone: 'lrn-green',
      sub: `${pctOfInvited(stats.complete)}% of invited` },
    { key: 'overdue', label: 'Overdue', value: stats.overdue, tone: 'lrn-red', alert: stats.overdue > 0,
      sub: due ? `Due ${dayLabel(due.date)}` : 'No due date yet' },
  ];

  const invites = schedule.mode === 'manual'
    ? 'By hand: nothing goes out until you send it'
    : `${plural(schedule.send_offset_days, 'day')} before start, ${timeLabel(schedule.send_time)} site time`;
  const reminderText = schedule.reminder_offsets.length === 0
    ? 'None'
    : `${joinNumbers(schedule.reminder_offsets)} ${schedule.reminder_offsets.length === 1 && schedule.reminder_offsets[0] === 1 ? 'day' : 'days'} before start`;

  const closeDialog = () => setDialog(null);

  return (
    <div className="lrn-initab">
      <div className="lrn-initab-actions">
        {canReport && (
          <button type="button" className="btn-ghost" disabled={reporting} onClick={() => void runReport()}>
            Compliance report
          </button>
        )}
        {canChange && (
          <button type="button" className="btn-ghost" onClick={() => setDialog('sheet')}>Print code sheet</button>
        )}
        {canChange && (
          <button type="button" className="btn-solid" onClick={() => setDialog('send')}>Send invites now</button>
        )}
      </div>

      <div className="lrn-tiles lrn-tiles-5" role="group" aria-label="Learning progress">
        {tiles.map((t) => (
          <div key={t.key} className={`lrn-tile${t.alert ? ' lrn-tile-alert' : ''}`}>
            <div className={`lrn-tile-v ${t.tone ?? ''}`}>{t.value.toLocaleString()}</div>
            <div className="lrn-tile-k">{t.label}</div>
            <div className="lrn-tile-d">{t.sub}</div>
          </div>
        ))}
      </div>

      <div className="lrn-initab-cards">
        <section className="lrn-card" aria-label="Invites and reminders">
          <div className="lrn-section-head">
            <p className="lrn-kicker">Invites and reminders</p>
            {canChange && (
              <button type="button" className="mini-btn" onClick={() => setDialog('schedule')}>Edit schedule</button>
            )}
          </div>
          <LearningTimeline events={data.timeline} />
          <dl className="kv lrn-kv">
            <dt>Invites</dt>
            <dd>
              {invites}
              {schedule.sent_at && <span className="chip c-green lrn-kv-chip">Sent</span>}
              {schedule.is_default && !schedule.sent_at && <span className="chip c-slate lrn-kv-chip">Company default</span>}
            </dd>
            <dt>Reminders</dt>
            <dd>{reminderText}</dd>
            <dt>Due</dt>
            <dd>{plural(schedule.due_offset_days, 'day')} before start</dd>
            <dt>Codes expire</dt>
            <dd>{schedule.codes_expire_on ? dayLabelYear(schedule.codes_expire_on) : '—'}</dd>
            <dt>Late adds</dt>
            <dd>{schedule.late_adds ? 'Invited automatically when added' : 'Not invited automatically'}</dd>
          </dl>
        </section>

        <section className="lrn-card" aria-label="What this initiative requires">
          <div className="lrn-section-head">
            <p className="lrn-kicker">What this initiative requires</p>
            <div className="lrn-actions">
              {canAdd && <button type="button" className="mini-btn" onClick={() => setDialog('assign')}>Assign</button>}
              <button type="button" className="mini-btn" onClick={() => setDialog('preview')}>Preview rules</button>
            </div>
          </div>
          {data.packets.length === 0 && data.extras.length === 0 && (
            <p className="lrn-hint">Nothing is assigned yet. Preview the rules to see who would get what.</p>
          )}
          <ul className="lrn-req">
            {data.packets.map((p) => (
              <li key={p.packet.id}>
                <span className="lrn-req-text">
                  <span className="cell-top">{p.packet.name}</span>
                  <span className="cell-sub">{p.packet.documents.join(' · ')}</span>
                  {p.rule_name && <span className="lrn-hint">From the rule: {p.rule_name}</span>}
                </span>
                {p.every_initiative && <span className="chip c-violet">Every initiative</span>}
              </li>
            ))}
            {data.extras.map((x) => (
              <li key={x.title}>
                <span className="lrn-req-text">
                  <span className="cell-top">{x.title}</span>
                  <span className="cell-sub">{`Extra · ${plural(x.people, 'person', 'people')}`}</span>
                </span>
                <span className="chip c-amber">Extra</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <LearningRoster rows={rows} counts={counts} filter={filter} onFilter={setFilter}
                      loading={filterLoading} failed={rosterFailed} onRetry={refresh}
                      canChange={canChange} canViewWorker={canViewWorker} busyId={busyId}
                      onResend={(ids) => void resend(ids)} onRegenerate={(r) => void regenerate(r)}
                      onRevoke={(r) => setDialog({ revoke: r })}
                      onHistory={(r) => navigate(`/people/workers/${r.person_id}`)} />

      <ComplianceGrid initiativeId={initiativeId} version={version} />

      {dialog === 'send' && (
        <SendInvitesModal initiativeId={initiativeId} roster={everyone} onClose={closeDialog}
                          onSent={() => refresh()} />
      )}
      {dialog === 'schedule' && (
        <ScheduleModal initiativeId={initiativeId} schedule={schedule} onClose={closeDialog}
                       onSaved={() => { closeDialog(); toast('Schedule saved'); refresh(); }} />
      )}
      {dialog === 'sheet' && (
        <CodeSheetModal initiativeId={initiativeId} onClose={closeDialog}
                        onDownloaded={() => { closeDialog(); toast('Code sheet downloaded'); refresh(); }} />
      )}
      {dialog === 'preview' && (
        <LearningModal eyebrow="Learning" title="Preview rules" wide onClose={closeDialog}
                       description="What the assignment rules would give people on this initiative right now."
                       footer={<button type="button" className="btn-solid" onClick={closeDialog}>Close</button>}>
          <DryRunPanel initiativeId={initiativeId} onApplied={refresh} />
        </LearningModal>
      )}
      {dialog === 'assign' && (
        <AssignExtraModal initiativeId={initiativeId} people={everyone ?? []} onClose={closeDialog}
                          onAssigned={refresh} />
      )}
      {typeof dialog === 'object' && dialog !== null && (
        <RevokeCodesModal initiativeId={initiativeId} personId={dialog.revoke.person_id}
                          name={dialog.revoke.name} onClose={closeDialog}
                          onRevoked={(n) => {
                            closeDialog();
                            toast(`Revoked ${plural(n, 'code')} for ${dialog.revoke.name}`);
                            refresh();
                          }} />
      )}
    </div>
  );
}
