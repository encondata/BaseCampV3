/** The quiz (mockup screen 5): one question per screen, single or multiple
 *  choice, a progress bar and "Check answer" on to the next. The answers
 *  are graded together after the last one; the result screen shows the
 *  score. A pass goes back to the document to sign; a fail offers another
 *  try while there are tries left, and says the lead has been told once
 *  there are none. Every screen has a way back to read the document again. */
import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';

import { ApiError } from '@portal/lib/api';

import LoadState from '../components/LoadState';
import ProgressBar from '../components/ProgressBar';
import { errorKey } from '../lib/errors';
import { isUuid } from '../lib/ids';
import type { MessageKey } from '../i18n/en';
import { getLang, t, useLang } from '../lib/i18n';
import {
  getQuiz, getTraining, submitQuiz, type QuizQuestion, type QuizResult,
} from '../lib/training';
import { useLoad } from '../lib/useLoad';

function ReadAgain({ id }: { id: string }) {
  return <Link className="learn-link" to={`/training/${encodeURIComponent(id)}`}>{t('quiz.readAgain')}</Link>;
}

/** The title for the header, from the training list (blank if it won't load). */
async function titleOf(id: string): Promise<string> {
  try {
    const { groups } = await getTraining();
    return groups.flatMap((g) => g.items).find((i) => i.assignment_id === id)?.title ?? '';
  } catch { return ''; }
}

function Questions({ id, title, questions, onResult }: {
  id: string; title: string; questions: QuizQuestion[]; onResult: (r: QuizResult) => void;
}) {
  const navigate = useNavigate();
  const [at, setAt] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  const q = questions[at];
  const picked = answers[q.id] ?? [];
  const last = at === questions.length - 1;

  const pick = (choice: string) => {
    setError(null);
    setAnswers((a) => {
      const have = a[q.id] ?? [];
      if (!q.multiple) return { ...a, [q.id]: [choice] };
      return { ...a, [q.id]: have.includes(choice) ? have.filter((c) => c !== choice) : [...have, choice] };
    });
  };

  const next = async () => {
    if (!picked.length || busy) return;
    if (!last) { setAt(at + 1); return; }
    setBusy(true);
    try {
      onResult(await submitQuiz(id, answers));
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === 'already_signed') { navigate('/training', { replace: true }); return; }
      setError(errorKey(err));
    }
  };

  return (
    <>
      <div className="learn-readhead">
        <Link to="/training" className="learn-backlink" aria-label={t('common.back')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
               strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5m6-6-6 6 6 6" /></svg>
        </Link>
        <div>
          <div className="eyebrow">{title ? t('quiz.eyebrow', { title }) : ''}</div>
          <h1 className="learn-doctitle">{t('quiz.question', { n: at + 1, total: questions.length })}</h1>
        </div>
      </div>
      <ProgressBar value={at + 1} max={questions.length} label={t('quiz.question', { n: at + 1, total: questions.length })} />

      <fieldset className="learn-quiz" key={q.id}>
        <legend className="learn-prompt">{q.prompt}</legend>
        <p className="learn-sub">{q.multiple ? t('quiz.pickMany') : t('quiz.pickOne')}</p>
        {q.choices.map((c) => (
          <label key={c.id} className={`learn-choice ${picked.includes(c.id) ? 'sel' : ''}`}>
            <input type={q.multiple ? 'checkbox' : 'radio'} name={q.id} checked={picked.includes(c.id)}
                   onChange={() => pick(c.id)} />
            <span>{c.text}</span>
          </label>
        ))}
      </fieldset>

      <p className={`learn-reason ${error ? 'show' : ''}`} role="status" aria-live="polite">
        {error ? t(error) : ''}
      </p>
      <button type="button" className="learn-cta" disabled={!picked.length || busy} onClick={next}>
        {busy ? t('quiz.checking') : last ? t('quiz.finish') : t('quiz.check')}
      </button>
      <ReadAgain id={id} />
    </>
  );
}

function Result({ id, result, onRetry }: { id: string; result: QuizResult; onRetry: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="learn-result">
      <div className={`learn-badge ${result.passed ? 'ok' : 'no'}`} aria-hidden="true">
        {result.passed ? '✓' : '!'}
      </div>
      <h1 className="learn-doctitle">{t('quiz.score', { score: result.score_percent })}</h1>
      {result.passed ? (
        <>
          <p className="learn-sub">{t('quiz.passed')}</p>
          <button type="button" className="learn-cta" onClick={() => navigate(`/training/${encodeURIComponent(id)}`, { replace: true })}>
            {t('quiz.continue')}
          </button>
        </>
      ) : result.locked ? (
        <>
          <p className="learn-sub" role="alert">{t('quiz.locked')}</p>
          <Link className="learn-cta" to="/training">{t('quiz.back')}</Link>
          <ReadAgain id={id} />
        </>
      ) : (
        <>
          <p className="learn-sub">
            {t('quiz.failed')}
            {result.attempts_left != null && (
              <> {result.attempts_left === 1
                ? t('quiz.oneTryLeft') : t('quiz.triesLeft', { n: result.attempts_left })}</>
            )}
          </p>
          <button type="button" className="learn-cta" onClick={onRetry}>{t('quiz.tryAgain')}</button>
          <ReadAgain id={id} />
        </>
      )}
    </div>
  );
}

function QuizPage({ id }: { id: string }) {
  useLang();
  const lang = getLang();
  // each try reads a fresh draw of the questions
  const [round, setRound] = useState(0);
  const [result, setResult] = useState<QuizResult | null>(null);
  const questions = useLoad(() => getQuiz(id, lang), [id, lang, round]);
  const title = useLoad(() => titleOf(id), [id]);

  return (
    <main className="learn-page learn-reader">
      {result ? (
        <Result id={id} result={result} onRetry={() => { setResult(null); setRound((n) => n + 1); }} />
      ) : questions.data && questions.data.length > 0 ? (
        <Questions key={round} id={id} title={title.data ?? ''} questions={questions.data} onResult={setResult} />
      ) : questions.data ? (
        <p className="learn-note">{t('error.not_found')}</p>
      ) : (
        <LoadState error={questions.error} onRetry={questions.reload} />
      )}
    </main>
  );
}

export default function Quiz() {
  const { id = '' } = useParams();
  // the id is typed into the address bar: only a real one goes into a path
  return isUuid(id) ? <QuizPage id={id} /> : <Navigate to="/training" replace />;
}
