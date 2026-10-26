/** Routes. `/` is the sign-in (code or account), `/start` the invite
 *  link; everything else needs a learn session or an account. A 401 from
 *  any signed-in call comes back to `/` through the router. */
import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import { t, useLang } from './lib/i18n';
import { getToken, setSignedOutHandler } from './lib/session';
import SignIn from './pages/SignIn';
import Start from './pages/Start';

/** A learn token or a portal account; nothing while the account session
 *  is still being restored; otherwise back to sign-in. */
export function RequireLearner({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (getToken() || status === 'authed') return <>{children}</>;
  if (status === 'loading') return null;
  return <Navigate to="/" replace />;
}

/** Where the training screens mount once they exist. */
function Training() {
  useLang();
  return (
    <main className="learn-page">
      <div className="eyebrow">{t('app.name')}</div>
    </main>
  );
}

export default function App() {
  const navigate = useNavigate();
  useEffect(() => setSignedOutHandler(() => navigate('/', { replace: true })), [navigate]);
  return (
    <Routes>
      <Route path="/" element={<SignIn />} />
      <Route path="/start" element={<Start />} />
      <Route path="/training" element={<RequireLearner><Training /></RequireLearner>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
