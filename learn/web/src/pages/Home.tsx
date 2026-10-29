/** Home: the landing page after sign-in, on the portal's dashboard idiom.
 *  Three tiles (to sign, completed, moves), then what to do next (open,
 *  unlocked documents, with a Continue button) beside what was signed
 *  lately. Built from the shared training and history loads; a failed
 *  history load only empties its panel and dashes its tile. Once
 *  everything is signed, a panel at the top points to the time clock code. */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import HistoryList from '../components/HistoryList';
import LoadState from '../components/LoadState';
import TaskRow from '../components/TaskRow';
import Icon from '../layout/Icon';
import { dueDay, signedDay } from '../lib/format';
import { t, useLang } from '../lib/i18n';
import { learnerName, useLearnerData } from '../lib/learner';
import { getToken } from '../lib/session';
import type { TrainingItem } from '../lib/training';

const CHECK = 'M8.5 12.2l2.4 2.4 4.7-4.9M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z';
const DOCS = 'M7 3.5h7l4 4V20.5H7zM14 3.5v4h4M9.5 12.5h5M9.5 16h5';
const LIMIT = 5;

function Empty({ icon, title, hint }: { icon: string; title: string; hint: string }) {
  return (
    <div className="learn-empty">
      <span className="learn-empty-icon"><Icon d={icon} /></span>
      <div className="dash-panel-empty">{title}</div>
      <p className="learn-empty-hint">{hint}</p>
    </div>
  );
}

function Panel({ title, link, className, children }: {
  title: string; link?: ReactNode; className?: string; children: ReactNode;
}) {
  return (
    <section className={`dash-panel ${className ?? ''}`.trim()}>
      <div className="dash-panel-head">
        <h2 className="dash-panel-title">{title}</h2>
        {link && <div className="dash-panel-head-right">{link}</div>}
      </div>
      {children}
    </section>
  );
}

export default function Home() {
  useLang();
  const { person } = useAuth();
  const { training, history } = useLearnerData();
  // a learn token wins over an account, as it does for every call
  const { first } = learnerName(getToken() ? null : person);
  const data = training.data;
  const signed = history.data;

  const groups = data?.groups ?? [];
  const open: TrainingItem[] = groups.flatMap((g) => g.items).filter((i) => i.status !== 'signed');
  // Up next and Continue offer only what can be opened now, in list order
  const upNext = open.filter((i) => !i.locked).slice(0, LIMIT);
  const next = upNext[0];
  const dues = groups.filter((g) => g.due_on && g.items.some((i) => i.status !== 'signed'))
    .map((g) => g.due_on as string).sort();
  const moves = groups.filter((g) => g.initiative).length;
  const recent = signed?.slice(0, LIMIT) ?? [];

  const moveSub = moves > 0 ? '' : groups.length > 0 ? t('home.generalOnly') : t('home.noneAssigned');

  return (
    <div className="portal-page learn-home">
      <div className="eyebrow">{t('nav.section')}</div>
      <h1 className="page-title">{first ? t('home.title', { name: first }) : t('home.titleNoName')}</h1>
      {data && (
        <p className="page-hint">
          {open.length > 0 ? t('home.toSignHint', { n: open.length }) : t('home.caughtUp')}
        </p>
      )}

      {!data && <LoadState error={training.error} onRetry={() => { training.reload(); history.reload(); }} />}

      {data && (
        <div className="dash-grid">
          <div className="dash-kpis">
            <div className="dash-kpi">
              <div className="dash-kpi-label">{t('home.kpiToSign')}</div>
              <div className="dash-kpi-value">{open.length}</div>
              <div className="dash-kpi-sub">
                {dues.length > 0 ? t('home.nextDue', { date: dueDay(dues[0]) }) : t('home.nothingDue')}
              </div>
            </div>
            <div className="dash-kpi">
              <div className="dash-kpi-label">{t('home.kpiCompleted')}</div>
              <div className="dash-kpi-value">{signed ? signed.length : '—'}</div>
              <div className="dash-kpi-sub">
                {signed && signed.length > 0
                  ? t('home.lastSigned', { date: signedDay(signed[0].signed_at) })
                  : signed ? t('home.noneYet') : ''}
              </div>
            </div>
            <div className="dash-kpi">
              <div className="dash-kpi-label">{t('home.kpiMoves')}</div>
              <div className="dash-kpi-value">{moves}</div>
              <div className="dash-kpi-sub">{moveSub}</div>
            </div>
          </div>

          {data.complete && data.badge_uid && (
            <Panel title={t('nav.timeClock')} className="dash-span-12">
              <div className="learn-clock">
                <p>{t('home.timeClock')}</p>
                <Link className="learn-cta" to="/done">{t('home.showCode')}</Link>
              </div>
            </Panel>
          )}

          <Panel title={t('home.upNext')} className="dash-span-6"
                 link={<Link className="dash-panel-link" to="/training">{t('home.allTraining')}</Link>}>
            {!next
              ? <Empty icon={CHECK} title={t('home.upNextEmpty')} hint={t('home.upNextEmptyHint')} />
              : (
                <>
                  <ul className="learn-tasks">
                    {upNext.map((item) => <TaskRow key={item.assignment_id} item={item} next={item === next} />)}
                  </ul>
                  <Link className="learn-cta learn-continue" to={`/training/${next.assignment_id}`}>
                    {t('training.continue', { title: next.title })}
                  </Link>
                </>
              )}
          </Panel>

          <Panel title={t('home.recent')} className="dash-span-6"
                 link={signed && signed.length > 0
                   ? <Link className="dash-panel-link" to="/history">{t('home.viewAll', { n: signed.length })}</Link>
                   : undefined}>
            {recent.length > 0
              ? <HistoryList items={recent} />
              : history.loading && !signed
                ? <p className="learn-note" aria-live="polite">{t('common.loading')}</p>
                : <Empty icon={DOCS} title={t('home.recentEmpty')} hint={t('home.recentEmptyHint')} />}
          </Panel>
        </div>
      )}
    </div>
  );
}
