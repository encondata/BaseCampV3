/** "My training" (mockup "Worker learn site", screen 3): the greeting, one
 *  block per scope (an initiative, or the general set) with its progress
 *  and its documents, and a button into the next unsigned one. When
 *  everything is signed the button takes the worker to their time clock
 *  code. What they signed is "Completed training": listed here when nothing
 *  else is open, otherwise a link to its own page. */
import { Link } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import HistoryList from '../components/HistoryList';
import LanguageLinks from '../components/LanguageLinks';
import LoadState from '../components/LoadState';
import ProgressBar from '../components/ProgressBar';
import TaskRow from '../components/TaskRow';
import { dueDay } from '../lib/format';
import { t, useLang } from '../lib/i18n';
import { getFirstName } from '../lib/session';
import { getHistory, getTraining, type TrainingItem } from '../lib/training';
import { useLoad } from '../lib/useLoad';

export default function Training() {
  useLang();
  const { person } = useAuth();
  const { data, error, reload } = useLoad(getTraining, []);
  // a failed history load only hides the history parts
  const hist = useLoad(getHistory, []);
  const history = hist.data ?? [];
  // the history parts wait for the load to settle, so they don't pop in late
  const settled = !hist.loading;
  const first = getFirstName() || person?.first_name || '';

  // the next document: the first open, unlocked one, in list order
  const all = data?.groups.flatMap((g) => g.items) ?? [];
  const next: TrainingItem | undefined = all.find((i) => i.status !== 'signed' && !i.locked);

  return (
    <main className="learn-page">
      <div className="learn-top">
        <span className="learn-mark" aria-hidden="true" />
        <span>{t('app.short')}</span>
      </div>
      <h1 className="learn-hi">{first ? t('training.hi', { name: first }) : t('training.hiNoName')}</h1>

      {!data && <LoadState error={error} onRetry={() => { reload(); hist.reload(); }} />}

      {data && settled && data.groups.length === 0 && <p className="learn-note">{t('training.caughtUp')}</p>}
      {data && settled && data.groups.length === 0 && history.length > 0 && (
        <section className="learn-group">
          <h2 className="eyebrow">{t('history.title')}</h2>
          <HistoryList items={history} />
        </section>
      )}

      {data?.groups.map((g) => {
        const done = g.items.filter((i) => i.status === 'signed').length;
        return (
          <section key={g.initiative?.id ?? 'general'} className="learn-group">
            <div className="eyebrow">{g.initiative?.name ?? t('training.general')}</div>
            <p className="learn-sub">
              {g.due_on
                ? t('training.progressDue', { done, total: g.items.length, date: dueDay(g.due_on) })
                : t('training.progress', { done, total: g.items.length })}
            </p>
            <ProgressBar value={done} max={g.items.length} label={t('training.progressLabel')} />
            <ul className="learn-tasks">
              {g.items.map((item) => (
                <TaskRow key={item.assignment_id} item={item}
                         next={item.assignment_id === next?.assignment_id} />
              ))}
            </ul>
          </section>
        );
      })}

      {next && (
        <Link className="learn-cta" to={`/training/${next.assignment_id}`}>
          {t('training.continue', { title: next.title })}
        </Link>
      )}
      {data?.complete && data.badge_uid && (
        <Link className="learn-cta" to="/done">{t('training.showCode')}</Link>
      )}
      {data && settled && data.groups.length > 0 && history.length > 0 && (
        <Link className="learn-link" to="/history">{t('history.link', { n: history.length })}</Link>
      )}

      <LanguageLinks />
    </main>
  );
}
