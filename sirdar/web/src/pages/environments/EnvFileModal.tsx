/** Download an environment's .env: the app .env it runs now, every password
 *  and key in it, after the user types their Sirdar password again. The API
 *  audits each download and each refused password. */
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ApiError, saveBlob } from '@portal/lib/api';

import { deployErrorText, downloadEnvFile, type Environment } from '../../lib/sirdarApi';

const WRONG_PASSWORD = "That password isn't right.";

export default function EnvFileModal({ env, eyebrow = 'Settings', onClose }: {
  env: Environment; eyebrow?: string; onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const input = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busyRef.current || !password) return;
    busyRef.current = true;
    setBusy(true);
    setPasswordError('');
    setError('');
    try {
      saveBlob(await downloadEnvFile(env.name, password), `${env.name}.env`);
      setPassword('');
      onCloseRef.current();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_current_password') {
        setPasswordError(WRONG_PASSWORD);
        input.current?.focus();
      } else {
        setError(deployErrorText(err, "Couldn't download the .env."));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form className="modal-card reports-modal-card rgm-card sirdar-deploy-card" role="dialog" aria-modal="true"
            aria-labelledby="sirdar-envfile-title" onSubmit={(e) => void submit(e)}>
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">{eyebrow}</div>
            <h3 id="sirdar-envfile-title">Download .env</h3>
            <p className="page-hint">
              This file holds every password and key for {env.name}. Keep it somewhere private.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form sirdar-deploy-form">
          <div>
            <label className="field-label" htmlFor="envfile-password">Your Sirdar password</label>
            <input id="envfile-password" ref={input} type="password" value={password} autoComplete="current-password"
                   disabled={busy} aria-invalid={!!passwordError}
                   aria-describedby={passwordError ? 'envfile-password-error' : undefined}
                   onChange={(e) => { setPassword(e.target.value); setPasswordError(''); }} />
            {passwordError && (
              <p id="envfile-password-error" className="form-error" role="alert">{passwordError}</p>
            )}
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-solid" disabled={busy || !password}>
            {busy ? 'Downloading…' : 'Download'}
          </button>
        </div>
      </form>
    </div>
  );
}
