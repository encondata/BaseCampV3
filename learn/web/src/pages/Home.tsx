/** Home: the landing page after sign-in. For now only its page head. */
import { t, useLang } from '../lib/i18n';

export default function Home() {
  useLang();
  return (
    <div className="portal-page learn-home">
      <div className="eyebrow">{t('nav.section')}</div>
      <h1 className="page-title">{t('nav.home')}</h1>
    </div>
  );
}
