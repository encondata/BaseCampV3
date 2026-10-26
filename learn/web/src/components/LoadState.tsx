/** What a signed-in page shows while its load is running or after it
 *  failed: the loading line, or the friendly error with a retry. */
import type { ApiError } from '@portal/lib/api';

import { errorKey } from '../lib/errors';
import { t } from '../lib/i18n';

export default function LoadState({ error, onRetry }: { error: ApiError | null; onRetry: () => void }) {
  if (!error) return <p className="learn-note" aria-live="polite">{t('common.loading')}</p>;
  // a locked or missing document won't come back by asking again
  const final = error.code === 'locked' || error.code === 'not_found' || error.code === 'already_signed';
  return (
    <div className="learn-note">
      <p role="alert">{t(errorKey(error))}</p>
      {!final && <button type="button" className="learn-link" onClick={onRetry}>{t('error.retry')}</button>}
    </div>
  );
}
