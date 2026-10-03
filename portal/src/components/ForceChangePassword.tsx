/**
 * Forced password change — shown INSTEAD of the portal when the account
 * must set a new password (temporary password from an admin, or an
 * expired one). There is no way around it except signing out.
 */

import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AuthCard from './AuthCard';
import ChangePasswordForm from './ChangePasswordForm';

export default function ForceChangePassword() {
  const { person, logout, clearMustChange, mustChangeReason } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <AuthCard
      title={mustChangeReason === 'expired' ? 'Your password has expired' : 'Set your password'}
      lead={mustChangeReason === 'expired'
        ? <>{person?.display_name}, passwords expire every so often here. Choose a new one to continue. It can&apos;t be one you&apos;ve used recently.</>
        : <>{person?.display_name}, your password was set by an administrator. Choose your own before continuing — the temporary one stops working the moment you do.</>}
    >
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
    </AuthCard>
  );
}
