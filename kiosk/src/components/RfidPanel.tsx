/** Settings › RFID (laptop only): the Dock's "Crate window" row.
 *
 *  The window lives on the edge (GET/PUT /edge/dock/window), so every screen
 *  on this laptop agrees. It saves on blur or Enter under the signed-in
 *  role's rule: an admin sets a whole number of seconds from 1 to 10, a
 *  developer any number above 0, up to 3600. Anyone else sees it locked. An
 *  admin looking at a developer's value (30, say) can leave it alone: an
 *  unchanged field is never validated or saved. A failed save restores the
 *  last saved value and says so. The field stays disabled until the window
 *  loads (a failed read leaves it so, with its error), and only the newest
 *  save's result is applied. */

import { useEffect, useRef, useState } from 'react';

import { useKioskAuth } from '../auth/KioskAuthContext';
import { ApiError, getDockWindow, saveDockWindow } from '../lib/api';

const ADMIN_MIN = 1;
const ADMIN_MAX = 10;
const DEVELOPER_MAX = 3600;

const LOCKED_TEXT = 'Only an admin can change this.';
const ADMIN_INVALID = 'Enter a whole number of seconds from 1 to 10.';
const DEVELOPER_INVALID = 'Enter a number of seconds above 0, up to 3600.';
const READ_ERROR = "Couldn't read the crate window from this laptop.";
const SAVE_ERROR = "Couldn't save the crate window. The last saved value is still in use.";

/** Seconds in the role's range, or null. */
function parseWindow(text: string, developer: boolean): number | null {
  const t = text.trim();
  if (developer) {
    if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
    const n = Number(t);
    return n > 0 && n <= DEVELOPER_MAX ? n : null;
  }
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= ADMIN_MIN && n <= ADMIN_MAX ? n : null;
}

export default function RfidPanel() {
  const { isAdmin, isDeveloper } = useKioskAuth();
  const canEdit = isDeveloper || isAdmin;
  const [saved, setSaved] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by every save; a result for an older save is ignored. */
  const saveSeq = useRef(0);

  useEffect(() => {
    let live = true;
    getDockWindow().then(
      (w) => {
        if (!live) return;
        setSaved(w.window_s);
        setText(String(w.window_s));
      },
      () => { if (live) setError(READ_ERROR); },
    );
    return () => { live = false; };
  }, []);

  const commit = () => {
    if (saved === null || !canEdit) return;
    // Untouched: nothing to validate or save (an admin may be looking at a
    // developer's value that is outside their own range).
    if (text.trim() === String(saved)) {
      setInvalid(false);
      return;
    }
    const n = parseWindow(text, isDeveloper);
    if (n === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setError(null);
    setText(String(n));
    if (n === saved) return;
    const previous = saved;
    const seq = ++saveSeq.current;
    setSaved(n);
    saveDockWindow(n).then(
      (w) => {
        if (seq !== saveSeq.current) return;
        setSaved(w.window_s);
        setText(String(w.window_s));
      },
      (e: unknown) => {
        if (seq !== saveSeq.current) return;
        setSaved(previous);
        setText(String(previous));
        setError(e instanceof ApiError && e.status === 403 ? LOCKED_TEXT : SAVE_ERROR);
      },
    );
  };

  const rule = isDeveloper ? DEVELOPER_INVALID : ADMIN_INVALID;

  return (
    <div className="settings-row">
      <div>
        <label htmlFor="dock-window" className="settings-row-label">Crate window</label>
        <p className="settings-row-hint">
          Devices read within this many seconds before or after a crate tag go into that crate.
          {' '}Two crates read within twice this time are both flagged, and nothing in them packs.
          {' '}A change applies from the next crate.
        </p>
        {!canEdit && <p className="settings-row-hint">{LOCKED_TEXT}</p>}
        {invalid && <p className="form-error">{rule}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <span className="alarm-seconds">
        <input
          id="dock-window"
          type="text"
          inputMode="decimal"
          aria-label="Crate window in seconds"
          aria-invalid={invalid || undefined}
          disabled={saved === null || !canEdit}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        />
        <span className="alarm-seconds-unit">seconds</span>
      </span>
    </div>
  );
}
