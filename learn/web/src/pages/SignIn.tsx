/** The learn site's sign-in (mockup "Worker learn site", screen 2): the
 *  shared light sign-in scene (LoginScene + login-light.css, as the kiosk
 *  uses it) with the learn form on the right. The default is the
 *  learning code from the invite email plus the worker's last name; below
 *  it, "Sign in with an account" swaps in the portal's own sign-in page
 *  (an account bearer works on /learn/* too), then the language links.
 *
 *  Someone already signed in either way goes straight to their training. */
import { lazy, Suspense, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import LoginScene from '@portal/components/login/LoginScene';
import { IconArrow } from '@portal/components/login/loginIcons';
import '@portal/styles/auth-theme.css';
import '@portal/styles/login-light.css';

import CodeBoxes, { CODE_LENGTH } from '../components/CodeBoxes';
import LanguageLinks from '../components/LanguageLinks';
import { normalizeCode, signInWithCode } from '../lib/api';
import { errorKey } from '../lib/errors';
import { t, useLang } from '../lib/i18n';
import { getToken, setToken } from '../lib/session';
import type { MessageKey } from '../i18n/en';

const AccountSignIn = lazy(() => import('../components/AccountSignIn'));

export default function SignIn() {
  useLang();
  const navigate = useNavigate();
  const { status } = useAuth();
  const [account, setAccount] = useState(false);
  const [code, setCode] = useState('');
  const [lastName, setLastName] = useState('');
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  if (getToken() || status === 'authed') return <Navigate to="/training" replace />;
  // the account session is still being restored: show nothing rather than
  // flash the form at someone who is about to be sent on
  if (status === 'loading') return null;

  if (account) {
    return (
      <Suspense fallback={null}>
        <AccountSignIn onUseCode={() => setAccount(false)} />
      </Suspense>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (normalizeCode(code).length !== CODE_LENGTH || !lastName.trim()) {
      setError('signin.incomplete');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await signInWithCode(code, lastName);
      setToken(session.token, session.expires_at, session.person.first_name);
      navigate('/training', { replace: true });
    } catch (err) {
      setError(errorKey(err));
      setBusy(false);
    }
  };

  return (
    <div className="login-shell login-light learn-signin">
      <LoginScene lead={null} accent={t('app.short')} sub={t('scene.sub')} />

      <main className="lx-form-col">
        <div className="form-wrap">
          <div className="eyebrow">{t('app.name')}</div>
          <h2 className="form-title">{t('signin.title')}</h2>
          <p className="form-hint">{t('signin.hint')}</p>

          <form onSubmit={submit} noValidate>
            <CodeBoxes value={code} autoFocus disabled={busy}
                       invalid={error === 'error.learn_code_invalid'}
                       onChange={(v) => { setCode(v); setError(null); }} />

            <div className="field">
              <label htmlFor="learn-last-name">{t('signin.lastName')}</label>
              <div className="control">
                <input id="learn-last-name" name="last_name" type="text" autoComplete="family-name"
                       value={lastName} disabled={busy}
                       onChange={(e) => { setLastName(e.target.value); setError(null); }} />
              </div>
            </div>

            <p className={`error-msg ${error ? 'show' : ''}`} role={error ? 'alert' : undefined}>
              {error ? t(error) : ''}
            </p>

            <button className={`btn ${busy ? 'loading' : ''}`} type="submit" disabled={busy}>
              <span>{busy ? t('signin.signingIn') : t('signin.continue')}</span>
              <IconArrow className="arrow" />
              <span className="spinner" />
            </button>
          </form>

          <div className="divider">{t('signin.or')}</div>

          <button className="btn-sso" type="button" onClick={() => setAccount(true)}>
            {t('signin.account')}
          </button>

          <LanguageLinks />
        </div>
      </main>
    </div>
  );
}
