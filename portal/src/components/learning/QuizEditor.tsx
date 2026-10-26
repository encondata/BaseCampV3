/**
 * The Quiz tab: the document's question pool and its quiz rules. Questions
 * add (learning:add), edit and reorder (change) and delete (delete); the
 * pass mark, attempts allowed and what happens on failure autosave through
 * the document PATCH (change). A manager without change sees the same as
 * text. Turning the quiz on or off is on the Content and rules tab.
 */

import { useEffect, useState } from 'react';

import {
  deleteQuestion, listQuestions, reorderQuestions,
  type DocumentPatch, type DocumentSettings, type LearningDocument, type QuizFailAction, type QuizQuestion,
} from '../../lib/learning';
import { apiErrorText, positiveInt } from '../../lib/learningDoc';
import LearningList, { type LearningColumn } from './LearningList';
import QuestionModal from './QuestionModal';
import { useLearningAccess } from './useLearningAccess';

export const QUESTION_COLUMNS = {
  question: { key: 'question', label: 'Question', width: '3fr', default: true, min: 220 },
  choices: { key: 'choices', label: 'Choices', width: '0.8fr', default: true, min: 90 },
  correct: { key: 'correct', label: 'Correct', width: '0.8fr', default: true, min: 90 },
  actions: { key: 'actions', label: 'Actions', width: '2fr', default: true, min: 260 },
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export default function QuizEditor({ doc, onSave }: {
  doc: LearningDocument;
  onSave: (patch: DocumentPatch) => Promise<boolean>;
}) {
  const can = useLearningAccess();
  const canChange = can('change');
  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<{ question?: QuizQuestion } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoadFailed(false);
    listQuestions(doc.id)
      .then(setQuestions)
      .catch(() => { setLoadFailed(true); setQuestions((q) => q ?? []); });
  };
  useEffect(() => { setQuestions(null); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [doc.id]);

  // ── settings ──────────────────────────────────────────────────────
  const [pending, setPending] = useState<Partial<DocumentSettings>>({});
  const shown: DocumentSettings = { ...doc, ...pending };
  const [passText, setPassText] = useState(doc.quiz_pass_percent === null ? '' : String(doc.quiz_pass_percent));
  const [attemptsText, setAttemptsText] = useState(doc.quiz_max_attempts === null ? '' : String(doc.quiz_max_attempts));
  const [settingError, setSettingError] = useState('');
  useEffect(() => { setPassText(doc.quiz_pass_percent === null ? '' : String(doc.quiz_pass_percent)); }, [doc.quiz_pass_percent]);
  useEffect(() => { setAttemptsText(doc.quiz_max_attempts === null ? '' : String(doc.quiz_max_attempts)); }, [doc.quiz_max_attempts]);

  const apply = async (patch: Partial<DocumentSettings>) => {
    setPending((p) => ({ ...p, ...patch }));
    const ok = await onSave(patch);
    setPending((p) => {
      const next = { ...p };
      (Object.keys(patch) as (keyof DocumentSettings)[]).forEach((k) => { delete next[k]; });
      return next;
    });
    return ok;
  };

  const lockNeedsAttempts = (action: QuizFailAction, attempts: number | null) =>
    shown.quiz_enabled && action === 'lock' && attempts === null;
  const needAttemptsText = 'Set how many attempts are allowed before the quiz locks.';

  const commitPass = () => {
    const n = positiveInt(passText);
    if (n === null || n > 100) { setSettingError('Enter a pass mark between 1 and 100.'); return; }
    setSettingError('');
    if (n !== shown.quiz_pass_percent) void apply({ quiz_pass_percent: n });
  };
  const commitAttempts = () => {
    const text = attemptsText.trim();
    const n = text === '' ? null : positiveInt(text);
    if (text !== '' && n === null) { setSettingError('Enter a whole number of attempts, or leave it empty for no limit.'); return; }
    if (lockNeedsAttempts(shown.quiz_fail_action, n)) { setSettingError(needAttemptsText); return; }
    setSettingError('');
    if (n !== shown.quiz_max_attempts) void apply({ quiz_max_attempts: n });
  };
  const pickAction = (action: QuizFailAction) => {
    if (action === shown.quiz_fail_action) return;
    if (lockNeedsAttempts(action, shown.quiz_max_attempts)) { setSettingError(needAttemptsText); return; }
    setSettingError('');
    void apply({ quiz_fail_action: action });
  };

  // ── questions ─────────────────────────────────────────────────────
  const remove = async (q: QuizQuestion) => {
    if (!window.confirm('Delete this question? Workers who already answered keep their results.')) return;
    setBusy(true);
    setError('');
    try {
      await deleteQuestion(q.id);
      setQuestions((list) => (list ?? []).filter((x) => x.id !== q.id));
    } catch (e) {
      setError(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const move = async (q: QuizQuestion, by: -1 | 1) => {
    const list = questions ?? [];
    const at = list.findIndex((x) => x.id === q.id);
    const to = at + by;
    if (to < 0 || to >= list.length) return;
    const ids = list.map((x) => x.id);
    [ids[at], ids[to]] = [ids[to], ids[at]];
    setBusy(true);
    setError('');
    try {
      setQuestions(await reorderQuestions(doc.id, ids));
    } catch (e) {
      setError(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const columns: LearningColumn<QuizQuestion>[] = [
    {
      def: QUESTION_COLUMNS.question,
      cell: (q) => <span className="cell-top cell-line" title={q.prompt}>{q.prompt}</span>,
    },
    { def: QUESTION_COLUMNS.choices, cell: (q) => <span className="cell-sub">{plural(q.choices.length, 'choice')}</span> },
    { def: QUESTION_COLUMNS.correct, cell: (q) => <span className="cell-sub">{q.correct_choice_ids.length} correct</span> },
    ...(canChange || can('delete') ? [{
      def: QUESTION_COLUMNS.actions,
      cell: (q: QuizQuestion) => {
        const at = (questions ?? []).findIndex((x) => x.id === q.id);
        return (
          <div className="lrn-actions">
            {canChange && (
              <>
                <button type="button" className="mini-btn" disabled={busy || at <= 0}
                        onClick={() => void move(q, -1)}>Move up</button>
                <button type="button" className="mini-btn" disabled={busy || at === (questions ?? []).length - 1}
                        onClick={() => void move(q, 1)}>Move down</button>
                <button type="button" className="mini-btn" onClick={() => setModal({ question: q })}>Edit</button>
              </>
            )}
            {can('delete') && (
              <button type="button" className="mini-btn" disabled={busy} onClick={() => void remove(q)}>Delete</button>
            )}
          </div>
        );
      },
    }] : []),
  ];

  return (
    <div className="lrn-tab">
      {!doc.quiz_enabled && (
        <p className="lrn-hint">
          The quiz is off for this document. Workers just read and sign; turn it on under
          Quiz after reading on the Content and rules tab.
        </p>
      )}

      <section className="lrn-card" aria-label="Quiz rules">
        <p className="eyebrow-sm">Quiz rules</p>
        {canChange ? (
          <div className="lrn-quiz-fields">
            <div>
              <label className="lrn-lbl" htmlFor="lrn-pass">Pass mark (percent)</label>
              <input id="lrn-pass" className="lrn-num" inputMode="numeric" value={passText}
                     onChange={(e) => { setPassText(e.target.value); setSettingError(''); }}
                     onBlur={commitPass} onKeyDown={(e) => { if (e.key === 'Enter') commitPass(); }} />
            </div>
            <div>
              <label className="lrn-lbl" htmlFor="lrn-attempts">Attempts allowed</label>
              <input id="lrn-attempts" className="lrn-num" inputMode="numeric" value={attemptsText}
                     placeholder="No limit"
                     onChange={(e) => { setAttemptsText(e.target.value); setSettingError(''); }}
                     onBlur={commitAttempts} onKeyDown={(e) => { if (e.key === 'Enter') commitAttempts(); }} />
            </div>
            <div>
              <span className="lrn-lbl">When they run out of attempts</span>
              <div className="segmented" role="group" aria-label="When they run out of attempts">
                <button type="button" aria-pressed={shown.quiz_fail_action === 'retry'}
                        className={shown.quiz_fail_action === 'retry' ? 'on' : ''}
                        onClick={() => pickAction('retry')}>Let them retry</button>
                <button type="button" aria-pressed={shown.quiz_fail_action === 'lock'}
                        className={shown.quiz_fail_action === 'lock' ? 'on' : ''}
                        onClick={() => pickAction('lock')}>Lock the quiz until an admin unlocks it</button>
              </div>
            </div>
          </div>
        ) : (
          <dl className="kv">
            <dt>Pass mark</dt><dd>{shown.quiz_pass_percent === null ? 'Not set' : `${shown.quiz_pass_percent}%`}</dd>
            <dt>Attempts allowed</dt><dd>{shown.quiz_max_attempts === null ? 'No limit' : shown.quiz_max_attempts}</dd>
            <dt>After the last attempt</dt>
            <dd>{shown.quiz_fail_action === 'lock' ? 'Locked until an admin unlocks it' : 'They can retry'}</dd>
          </dl>
        )}
        {settingError && <p className="pf-error" role="alert">{settingError}</p>}
      </section>

      <div className="lrn-section-head">
        <p className="eyebrow-sm">
          Questions
          {questions !== null && <span className="badge-count">{questions.length}</span>}
        </p>
        {can('add') && (
          <button type="button" className="mini-btn accent" onClick={() => setModal({})}>Add question</button>
        )}
      </div>
      {error && <p className="pf-error" role="alert">{error}</p>}
      {loadFailed && (
        <p className="pf-error" role="alert">
          Couldn&apos;t load the questions.{' '}
          <button type="button" className="mini-btn" onClick={load}>Try again</button>
        </p>
      )}
      {questions === null && <p className="page-hint">Loading…</p>}
      {questions !== null && !loadFailed && (
        <LearningList columns={columns} rows={questions} rowKey={(q) => q.id} ariaLabel="Questions"
                      empty={<><b>No questions yet</b>Add questions to build the quiz.</>} />
      )}

      {modal && (
        <QuestionModal documentId={doc.id} question={modal.question}
                       onClose={() => setModal(null)}
                       onSaved={(saved) => {
                         setQuestions((list) => {
                           const rest = list ?? [];
                           return modal.question
                             ? rest.map((x) => (x.id === saved.id ? saved : x))
                             : [...rest, saved];
                         });
                         setModal(null);
                       }} />
      )}
    </div>
  );
}
