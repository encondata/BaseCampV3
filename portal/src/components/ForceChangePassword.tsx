/**
 * Forced password change — shown INSTEAD of the portal when the account
 * carries must_change_password (temp password from an admin). There is
 * no way around it except signing out.
 */

import { type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import ChangePasswordForm from './ChangePasswordForm';
import '../styles/profile.css';
import '../styles/settings.css';

export default function ForceChangePassword() {
  const { person, logout, clearMustChange } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center',
      background: '#0c1117', padding: 24,
      fontFamily: "'Geologica', sans-serif",
      // This screen renders INSTEAD of .portal-shell, which is where the
      // theme variables live — without these, .btn-solid's background
      // resolves to nothing and the submit renders as bare text.
      '--accent': '#ffa12e',
      '--accent-soft': '#ffc06b',
      '--font-display': "'Geologica', sans-serif",
    } as CSSProperties}>
      <div style={{
        width: 'min(480px, 96vw)', background: '#fbfcfd', borderRadius: 18,
        padding: '30px 30px 26px', boxShadow: '0 40px 90px -30px rgba(0,0,0,.7)',
      }}>
        <p style={{
          fontFamily: "'Fragment Mono', monospace", fontSize: 10.5,
          letterSpacing: '.3em', textTransform: 'uppercase',
          color: '#ffa12e', margin: 0,
        }}>
          ServerSherpa Portal
        </p>
        <h1 style={{ margin: '10px 0 6px', fontSize: 24, color: '#1b2129' }}>
          Set your password
        </h1>
        <p style={{ margin: '0 0 22px', fontSize: 14, color: '#667085', fontWeight: 300 }}>
          {person?.display_name}, your password was set by an administrator.
          Choose your own before continuing — the temporary one stops working
          the moment you do.
        </p>
        <ChangePasswordForm onSuccess={clearMustChange} />
        <p style={{ margin: '18px 0 0', fontSize: 13, color: '#667085' }}>
          Not you?{' '}
          <button onClick={() => void handleLogout()} style={{
            background: 'none', border: 0, padding: 0, color: '#1b2129',
            font: 'inherit', fontWeight: 500, cursor: 'pointer',
            borderBottom: '1px solid #ffa12e',
          }}>
            Sign out
          </button>
        </p>
      </div>
    </div>
  );
}
