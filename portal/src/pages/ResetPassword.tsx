/**
 * /reset-password#token=… — the page a reset email links to. The token
 * rides in the fragment (never sent to a server or a Referer) and is
 * stripped from the address bar on load. A dead link offers a new one;
 * success sends the user to sign in, where 2FA still applies.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import AuthCard from '../components/AuthCard';
import ChangePasswordForm from '../components/ChangePasswordForm';
import { checkPasswordResetToken } from '../lib/api';
import { getSystemStatus } from '../lib/systemStatus';

type Phase = 'checking' | 'invalid' | 'form' | 'done';

const linkStyle = { color: '#1b2129', fontWeight: 500, borderBottom: '1px solid #ffa12e', textDecoration: 'none' };

export default function ResetPassword() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '');
  const [phase, setPhase] = useState<Phase>(token ? 'checking' : 'invalid');
  const [minLength, setMinLength] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    getSystemStatus().then((s) => setMinLength(s.password_min_length)).catch(() => {});
    if (!token) return;
    let live = true;
    checkPasswordResetToken(token)
      .then((ok) => { if (live) setPhase(ok ? 'form' : 'invalid'); })
      .catch(() => { if (live) setPhase('invalid'); });
    return () => { live = false; };
  }, [token]);

  if (phase === 'checking') return <AuthCard title="Checking your link…">{null}</AuthCard>;

  if (phase === 'invalid') {
    return (
      <AuthCard title="This link has expired or was already used"
                lead="Reset links work once and expire quickly. Ask for a new one from the sign-in page.">
        <Link to="/login?forgot=1" style={linkStyle}>Request a new link</Link>
      </AuthCard>
    );
  }

  if (phase === 'done') {
    return (
      <AuthCard title="Password changed"
                lead="Every device was signed out. Sign in with your new password.">
        <Link to="/login" style={linkStyle}>Sign in</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password"
              lead="It can't be one you've used recently.">
      <ChangePasswordForm resetToken={token} minLength={minLength} onSuccess={() => setPhase('done')} />
    </AuthCard>
  );
}
