/** "Completed training": everything the worker has signed, newest first,
 *  each row opening the document read-only. */
import { Link } from 'react-router-dom';

import HistoryList from '../components/HistoryList';
import LoadState from '../components/LoadState';
import { t, useLang } from '../lib/i18n';
import { getHistory } from '../lib/training';
import { useLoad } from '../lib/useLoad';

export default function History() {
  useLang();
  const { data, error, reload } = useLoad(getHistory, []);
  return (
    <main className="learn-page">
      <div className="learn-readhead">
        <Link to="/training" className="learn-backlink" aria-label={t('common.back')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
               strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5m6-6-6 6 6 6" /></svg>
        </Link>
        <h1 className="learn-doctitle">{t('history.title')}</h1>
      </div>

      {!data && <LoadState error={error} onRetry={reload} />}
      {data && data.length === 0 && <p className="learn-note">{t('history.empty')}</p>}
      {data && data.length > 0 && <HistoryList items={data} from="/history" />}
    </main>
  );
}
