/** "Completed training": everything the worker has signed, newest first,
 *  each row opening the document read-only. Under the shell's page head;
 *  the nav leads back to the rest. */
import EmptyState, { DOCS } from '../components/EmptyState';
import HistoryList from '../components/HistoryList';
import LoadState from '../components/LoadState';
import { useLearnerData } from '../lib/learner';
import { t, useLang } from '../lib/i18n';

export default function History() {
  useLang();
  const { data, error, reload } = useLearnerData().history;
  return (
    <div className="portal-page learn-list">
      <div className="eyebrow">{t('nav.section')}</div>
      <h1 className="page-title">{t('nav.history')}</h1>

      <div className="learn-list-body">
        {!data && <LoadState error={error} onRetry={reload} />}
        {data && data.length === 0 && (
          <div className="dash-panel">
            <EmptyState icon={DOCS} title={t('history.empty')} hint={t('home.recentEmptyHint')} />
          </div>
        )}
        {data && data.length > 0 && <HistoryList items={data} from="/history" />}
      </div>
    </div>
  );
}
