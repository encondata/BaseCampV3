/**
 * The worker page's Learning history panel: everything one person has done
 * in learning, from GET /learning/people/{id}/history — sign-offs (version,
 * language, read time, quiz score), quiz attempts, what is still open, and
 * time clock overrides — one segmented tab each, newest first. The API opens
 * the history to learning managers and to workers:view holders over this
 * worker; the Certificate button (typed names, drawn signatures) is for
 * learning managers only. A reader who can't see initiatives gets no
 * initiative names, so a row that belongs to one reads "An initiative".
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import DataTable, { type DataTableColumn } from '../DataTable';
import {
  downloadCertificate, getLearningHistory, languageName, type LearningHistory,
} from '../../lib/learning';
import { dateTime, readTime } from '../../lib/learningDoc';
import { longDateOf } from '../../lib/format';
import { parseApiDay } from '../../lib/timeline';
import { useLearningAccess } from './useLearningAccess';
import '../../styles/directory.css';
import '../../styles/learning.css';

type Tab = 'signoffs' | 'attempts' | 'open' | 'overrides';

const ASSIGNMENT_STATUS: Record<string, { label: string; cls: string }> = {
  assigned: { label: 'Assigned', cls: 'c-slate' },
  opened: { label: 'Opened', cls: 'c-blue' },
};

const SOURCE_LABEL: Record<string, string> = {
  rule: 'Assignment rule', manual: 'Assigned by hand', new_version: 'New version',
};

const OVERRIDE_REASON: Record<string, string> = {
  signing_on_break: 'Signing on a break', signed_on_paper: 'Signed on paper',
  no_phone: 'No phone', other: 'Other',
};

const SCOPE_LABEL: Record<string, string> = { punch: 'One punch', day: 'Rest of the day' };

/** The initiative's name, "An initiative" when it exists but its name was
 *  withheld, and "General" for the general set. */
const initiativeText = (r: { initiative_id: string | null; initiative: string | null }): string =>
  r.initiative ?? (r.initiative_id ? 'An initiative' : 'General');

const day = (iso: string): string => longDateOf(parseApiDay(iso));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function LearningHistoryPanel({ personId, personName }: {
  personId: string;
  personName: string;
}) {
  const canCertificate = useLearningAccess()('view');
  const [history, setHistory] = useState<LearningHistory | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<Tab>('signoffs');
  const [busy, setBusy] = useState(false);
  const [certError, setCertError] = useState('');
  const requestId = useRef(0);

  const load = useCallback(() => {
    const id = ++requestId.current;
    setFailed(false);
    getLearningHistory(personId)
      .then((h) => { if (id === requestId.current) setHistory(h); })
      .catch(() => { if (id === requestId.current) setFailed(true); });
  }, [personId]);
  useEffect(() => { setHistory(null); load(); return () => { requestId.current += 1; }; }, [load]);

  const certificate = async () => {
    setBusy(true);
    setCertError('');
    try {
      await downloadCertificate(personId, personName);
    } catch {
      setCertError("Couldn't download the certificate.");
    } finally {
      setBusy(false);
    }
  };

  const empty = history !== null && history.signoffs.length === 0
    && history.quiz_attempts.length === 0 && history.overrides.length === 0
    && history.open_assignments.length === 0;

  const tabs: { key: Tab; label: string; count: number }[] = history === null ? [] : [
    { key: 'signoffs', label: 'Sign-offs', count: history.signoffs.length },
    { key: 'attempts', label: 'Quiz attempts', count: history.quiz_attempts.length },
    { key: 'open', label: 'Open', count: history.open_assignments.length },
    { key: 'overrides', label: 'Time clock overrides', count: history.overrides.length },
  ];

  let columns: DataTableColumn[] = [];
  let rows: { key: string; cells: ReactNode[] }[] = [];
  let label = '';
  let emptyText = '';
  if (history) {
    if (tab === 'signoffs') {
      label = 'Sign-offs';
      emptyText = 'No sign-offs yet.';
      columns = [
        { key: 'document', label: 'Document' }, { key: 'version', label: 'Version', width: '72px' },
        { key: 'language', label: 'Language' }, { key: 'signed', label: 'Signed', mono: true },
        { key: 'read', label: 'Read time', mono: true }, { key: 'quiz', label: 'Quiz', mono: true, width: '64px' },
        { key: 'initiative', label: 'Initiative' },
      ];
      rows = history.signoffs.map((s) => ({
        key: s.id,
        cells: [
          <b className="cell-top" key="d">{s.document}</b>, `v${s.version}`, languageName(s.language),
          dateTime(s.signed_at), readTime(s.read_seconds),
          s.quiz_score === null ? '—' : `${s.quiz_score}%`, initiativeText(s),
        ],
      }));
    } else if (tab === 'attempts') {
      label = 'Quiz attempts';
      emptyText = 'No quiz attempts yet.';
      columns = [
        { key: 'document', label: 'Document' }, { key: 'result', label: 'Result' },
        { key: 'score', label: 'Score', mono: true, width: '64px' },
        { key: 'when', label: 'When', mono: true }, { key: 'initiative', label: 'Initiative' },
      ];
      rows = history.quiz_attempts.map((a) => ({
        key: a.id,
        cells: [
          <b className="cell-top" key="d">{a.document}</b>,
          <span key="r" className={`chip ${a.passed ? 'c-green' : 'c-red'}`}>
            <span className="dot" />{a.passed ? 'Passed' : 'Failed'}
          </span>,
          `${a.score_percent}%`, dateTime(a.created_at), initiativeText(a),
        ],
      }));
    } else if (tab === 'open') {
      label = 'Open assignments';
      emptyText = 'Nothing is waiting on this worker.';
      columns = [
        { key: 'document', label: 'Document' }, { key: 'status', label: 'Status' },
        { key: 'source', label: 'Assigned by' }, { key: 'due', label: 'Due', mono: true },
        { key: 'initiative', label: 'Initiative' },
      ];
      rows = history.open_assignments.map((a) => {
        const status = ASSIGNMENT_STATUS[a.status] ?? { label: a.status, cls: 'c-slate' };
        return {
          key: a.id,
          cells: [
            <b className="cell-top" key="d">{a.document}</b>,
            <span key="s" className={`chip ${status.cls}`}><span className="dot" />{status.label}</span>,
            SOURCE_LABEL[a.source] ?? a.source, a.due_on ? day(a.due_on) : '—', initiativeText(a),
          ],
        };
      });
    } else {
      label = 'Time clock overrides';
      emptyText = 'No time clock overrides.';
      columns = [
        { key: 'when', label: 'When', mono: true }, { key: 'admin', label: 'Admin' },
        { key: 'reason', label: 'Reason' }, { key: 'scope', label: 'Covers' },
        { key: 'initiative', label: 'Initiative' },
      ];
      rows = history.overrides.map((o) => ({
        key: o.id,
        cells: [
          dateTime(o.created_at), o.admin ?? '—',
          <span key="r">{OVERRIDE_REASON[o.reason] ?? o.reason}
            {o.reason_text && <span className="cell-sub"> · {o.reason_text}</span>}</span>,
          SCOPE_LABEL[o.scope] ?? o.scope, initiativeText(o),
        ],
      }));
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Learning history</h3>
        <span className="lrn-head-actions">
          {history && !empty && (
            <span className="result-count">{plural(history.signoffs.length, 'sign-off')}</span>
          )}
          {canCertificate && history && history.signoffs.length > 0 && (
            <button type="button" className="mini-btn" disabled={busy}
                    onClick={() => void certificate()}>Certificate</button>
          )}
        </span>
      </div>
      <div className="panel-body">
        {history === null && !failed && <p className="set-note" style={{ padding: 0 }}>Loading…</p>}
        {failed && (
          <div className="lrn-error" role="alert">
            <span className="set-note" style={{ padding: 0 }}>Couldn&apos;t load the learning history.</span>
            <button type="button" className="mini-btn" onClick={load}>Try again</button>
          </div>
        )}
        {certError && <p className="pf-error" role="alert">{certError}</p>}
        {empty && <p className="set-note" style={{ padding: 0 }}>No learning activity yet.</p>}
        {history !== null && !empty && (
          <>
            <div className="segmented lrn-tabs" role="tablist" aria-label="Learning history">
              {tabs.map((t) => (
                <button key={t.key} type="button" role="tab" aria-selected={t.key === tab}
                        className={t.key === tab ? 'on' : ''} onClick={() => setTab(t.key)}>
                  {t.label} ({t.count})
                </button>
              ))}
            </div>
            <DataTable ariaLabel={label} columns={columns} rows={rows} emptyText={emptyText} />
          </>
        )}
      </div>
    </div>
  );
}
