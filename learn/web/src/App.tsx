/** Routes. `/` is the sign-in (code or account), `/start` the invite
 *  link; everything else needs a learn session or an account: `/training`, a
 *  document (`/training/:id`) and its quiz, and `/done`. A 401 from
 *  any signed-in call comes back to `/` through the router. */
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import { getOfferedLanguages } from './lib/api';
import { setOffered } from './lib/i18n';
import { getToken, setSignedOutHandler } from './lib/session';
import Quiz from './pages/Quiz';
import Reader from './pages/Reader';
import SignIn from './pages/SignIn';
import Start from './pages/Start';
import Training from './pages/Training';

// the QR encoder is only for the time clock code at the very end
const Done = lazy(() => import('./pages/Done'));

/** A learn token or a portal account; nothing while the account session
 *  is still being restored; otherwise back to sign-in. */
export function RequireLearner({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (getToken() || status === 'authed') return <>{children}</>;
  if (status === 'loading') return null;
  return <Navigate to="/" replace />;
}

export default function App() {
  const navigate = useNavigate();
  useEffect(() => setSignedOutHandler(() => navigate('/', { replace: true })), [navigate]);
  // the language picker's list; without it the page stays in English (or
  // the saved choice) and the picker stays hidden
  useEffect(() => { getOfferedLanguages().then(setOffered).catch(() => {}); }, []);
  return (
    <Routes>
      <Route path="/" element={<SignIn />} />
      <Route path="/start" element={<Start />} />
      <Route path="/training" element={<RequireLearner><Training /></RequireLearner>} />
      <Route path="/training/:id" element={<RequireLearner><Reader /></RequireLearner>} />
      <Route path="/training/:id/quiz" element={<RequireLearner><Quiz /></RequireLearner>} />
      <Route path="/done" element={<RequireLearner><Suspense fallback={null}><Done /></Suspense></RequireLearner>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
