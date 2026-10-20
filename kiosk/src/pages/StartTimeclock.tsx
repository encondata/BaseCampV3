/** Start Time Clock: the Time Clock station's Home tile. The signed-in
 *  person arms this browser as the station's display (the edge sets its
 *  display cookie), is signed out, and lands on `/`, where the signed-out
 *  time clock takes over. A failed arm keeps them signed in here. */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useKioskAuth } from '../auth/KioskAuthContext';
import { ApiError } from '../lib/api';
import { armDisplay } from '../timeclock/stationApi';

function messageFor(err: unknown): string {
  const code = err instanceof ApiError ? err.code : '';
  if (code === 'not_timeclock_station') {
    return "This kiosk isn't set up as a Time Clock station yet. Run Kiosk Setup first.";
  }
  if (code === 'move_locked') {
    return "A move password can't start the time clock. Sign in with your own account.";
  }
  return "Couldn't start the time clock. Try again.";
}

export default function StartTimeclock() {
  const { logout } = useKioskAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      await armDisplay();
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
      return;
    }
    await logout();
    navigate('/', { replace: true });
  };

  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk · Time Clock</div>
      <h1 className="page-title">Start the time clock</h1>
      <p className="page-hint">This signs you out and shows the Welcome screen for workers.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="setup-actions">
        <button type="button" className="btn-solid" disabled={busy} onClick={() => void start()}>
          Start Time Clock
        </button>
      </div>
    </div>
  );
}
