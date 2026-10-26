/** All signed (mockup screen 6): the worker's time clock QR code, drawn
 *  from their badge value, with "Save to phone" and the note that it was
 *  emailed too. Reached only once everything is signed; anyone with work
 *  left is sent back to the list. */
import { useMemo } from 'react';
import { Link, Navigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import { qrDataUrl } from '@portal/lib/qr';

import LoadState from '../components/LoadState';
import { t, useLang } from '../lib/i18n';
import { getFirstName } from '../lib/session';
import { getTraining } from '../lib/training';
import { useLoad } from '../lib/useLoad';

export const QR_FILE = 'serversherpa-timeclock-qr.png';

export default function Done() {
  useLang();
  const { person } = useAuth();
  const { data, error, reload } = useLoad(getTraining, []);
  const uid = data?.complete ? data.badge_uid : null;
  const qr = useMemo(() => {
    if (!uid) return null;
    try { return qrDataUrl(uid); } catch { return null; }
  }, [uid]);

  if (data && !uid) return <Navigate to="/training" replace />;
  const first = getFirstName() || person?.first_name || '';
  const total = data?.groups.reduce((n, g) => n + g.items.length, 0) ?? 0;

  return (
    <main className="learn-page learn-done">
      {!data ? <LoadState error={error} onRetry={reload} /> : (
        <>
          <div className="learn-badge ok big" aria-hidden="true">✓</div>
          <h1 className="learn-hi">{first ? t('done.title', { name: first }) : t('done.titleNoName')}</h1>
          <p className="learn-sub">{t('done.sub', { n: total })}</p>

          {qr && <img className="learn-qr" src={qr} alt={t('done.qrAlt')} />}
          <p className="learn-sub">{t('done.hint')}</p>
          {qr && <a className="learn-cta" href={qr} download={QR_FILE}>{t('done.save')}</a>}
          <p className="learn-fine">{t('done.note')}</p>
          <Link className="learn-link" to="/training">{t('done.back')}</Link>
        </>
      )}
    </main>
  );
}
