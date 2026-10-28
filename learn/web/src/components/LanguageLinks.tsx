/** The offered languages' links (each under its own name) the sign-in,
 *  the invite-link card and the training list share; nothing when English
 *  is the only one. */
import { setLang, t, useLang, useOffered } from '../lib/i18n';

export default function LanguageLinks() {
  const lang = useLang();
  const offered = useOffered();
  if (offered.length < 2) return null;
  return (
    <nav className="learn-langs" aria-label={t('signin.language')}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
      </svg>
      {offered.map((l) => (
        <button key={l.code} type="button" lang={l.code} aria-pressed={l.code === lang}
                className={l.code === lang ? 'on' : ''} onClick={() => setLang(l.code)}>
          {l.name}
        </button>
      ))}
    </nav>
  );
}
