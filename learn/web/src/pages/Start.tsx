/** The invite email's one-click link: /start#t=<token>. The token rides in
 *  the fragment (never sent to a server or kept in logs) and comes out of
 *  the address at once, before the sign-in call answers, so it never
 *  lingers in history or a shared screenshot. Then it is traded for a learn
 *  session and the worker lands on their training. */
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import '@portal/styles/auth-theme.css';
import '@portal/styles/login-light.css';

import type { MessageKey } from '../i18n/en';
import { signInWithLink } from '../lib/api';
import { t, useLang } from '../lib/i18n';
import { setToken } from '../lib/session';
import { LanguageLinks, errorKey } from './SignIn';

function linkToken(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('t') || null;
}

export default function Start() {
  useLang();
  const navigate = useNavigate();
  const location = useLocation();
  // read once, at the first render: the address is cleaned right after
  const [token] = useState(() => linkToken(location.hash));
  const started = useRef(false);
  const [error, setError] = useState<MessageKey | null>(null);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    navigate('/start', { replace: true });
    signInWithLink(token)
      .then((session) => {
        setToken(session.token, session.expires_at);
        navigate('/training', { replace: true });
      })
      .catch((err: unknown) => {
        const key = errorKey(err);
        setError(key === 'error.learn_code_invalid' ? 'start.invalid' : key);
      });
  }, [token, navigate]);

  if (!token) return <Navigate to="/" replace />;

  return (
    <div className="login-shell login-light learn-start">
      <main className="learn-start-card" aria-live="polite">
        <div className="eyebrow">{t('app.name')}</div>
        {error ? (
          <>
            <p className="learn-start-msg" role="alert">{t(error)}</p>
            <Link className="btn learn-start-btn" to="/" replace><span>{t('start.enterCode')}</span></Link>
            <LanguageLinks />
          </>
        ) : (
          <p className="learn-start-msg">{t('start.signingIn')}</p>
        )}
      </main>
    </div>
  );
}
