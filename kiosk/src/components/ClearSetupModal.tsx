/** Clear Setup's confirm step (Settings › Developer). Says exactly what
 *  goes and what stays — including how many unsent scans would be lost,
 *  counted when it opens — then runs `runClearSetup` and reloads into the
 *  sign-in page, the way a just-installed kiosk starts. Same shell as the
 *  printer's factory reset: the destructive button is last and never
 *  autofocused, so a stray Enter cannot wipe the kiosk. */

import { useEffect, useState } from 'react';

import { useKioskAuth } from '../auth/KioskAuthContext';
import { countUnsent, runClearSetup } from '../lib/factoryReset';
import { isLaptop } from '../lib/platform';

/** Where the app goes after a clear. A full load, not a route change:
 *  nothing held in memory may outlive the data it described. */
export function reloadToLogin(): void {
  window.location.replace('/login');
}

export default function ClearSetupModal({ onClose, onDone = reloadToLogin }: {
  onClose: () => void;
  /** Replaced in tests; the app reloads into the sign-in page. */
  onDone?: () => void;
}) {
  const { heartbeatNow, logout } = useKioskAuth();
  const laptop = isLaptop();
  const [unsent, setUnsent] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    void countUnsent().then((n) => { if (live) setUnsent(n); });
    return () => { live = false; };
  }, []);

  const start = async () => {
    setRunning(true);
    setError('');
    try {
      await runClearSetup({ heartbeatNow, logout });
      onDone();
    } catch {
      setRunning(false);
      setError("Couldn't clear the laptop, so its setup and data were left as they were."
        + ' Settings are already back to their defaults. Try again.');
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !running) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card clear-setup-card" role="dialog" aria-label="Clear Setup">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Developer</div>
            <h3>Clear Setup</h3>
            <p className="page-hint">Puts this kiosk back to how it was out of the box, for testing setup and features from scratch.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={running}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-section">This clears</div>
          <ul className="clear-setup-list">
            <li>The setup: move, site, scan type and station.</li>
            <li>All local data: the move copy, built labels, uploaded sounds and any unsent scans.</li>
            <li>Every setting, back to its default, here and in the portal&apos;s copy for this kiosk.</li>
            {laptop && <li>On this laptop, its own copy of the move, its sign-ins and its station setup.</li>}
            <li>Your sign-in. You land on the sign-in page.</li>
          </ul>
          <div className="modal-section">This keeps</div>
          <p className="page-hint">This kiosk&apos;s name and serial, so the portal still sees the same kiosk.</p>

          {unsent === null && <p className="page-hint">Checking for unsent scans…</p>}
          {unsent !== null && unsent > 0 && (
            <div className="zp-notice error" role="alert">
              <p className="page-hint">
                <b>{unsent === 1 ? '1 unsent scan' : `${unsent} unsent scans`} will be erased.</b>
                {' '}They haven&apos;t reached the portal and can&apos;t be recovered.
              </p>
            </div>
          )}
          {unsent === 0 && <p className="page-hint">No unsent scans.</p>}
          {error && <div className="zp-notice error" role="alert"><p className="page-hint">{error}</p></div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="mini-btn" autoFocus disabled={running} onClick={onClose}>Cancel</button>
          <button type="button" className="btn-solid btn-danger" disabled={running || unsent === null}
                  onClick={() => void start()}>
            {running ? 'Clearing…' : 'Clear Setup'}
          </button>
        </div>
      </div>
    </div>
  );
}
