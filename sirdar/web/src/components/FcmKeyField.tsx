/** The Firebase push key: write-only like SecretField ("set / not set", Clear,
 *  Keep / Undo to back out), but picked from the service-account JSON file
 *  rather than typed. The file is checked and base64-encoded in the browser;
 *  a bad one shows why and leaves the saved key as it was. `disabled` (a
 *  view-only reader) shows the state alone. */
import { useRef, useState } from 'react';

import { fcmKeyFromFile } from '../lib/fcmKey';

import type { SecretAction } from './SecretField';

export default function FcmKeyField({ id, label, hint, isSet, action, error, disabled = false, onAction, onValue }: {
  id: string; label: string; hint: string; isSet: boolean; action: SecretAction; error?: string;
  disabled?: boolean;
  onAction: (a: SecretAction) => void; onValue: (v: string) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [problem, setProblem] = useState('');

  const pick = async (file: File | null) => {
    if (!file) return;
    const got = await fcmKeyFromFile(file);
    if ('problem' in got) {
      setProblem(got.problem);
      onValue('');
      onAction('keep');
      return;
    }
    setProblem('');
    setFileName(file.name);
    onValue(got.key);
    onAction('set');
  };
  const back = (a: SecretAction) => { setProblem(''); onValue(''); onAction(a); };

  const state = disabled ? (isSet ? 'set' : 'not set')
    : action === 'set' ? `${fileName} chosen`
      : action === 'clear' ? 'will be cleared' : isSet ? 'set' : 'not set';
  const choose = (
    <button type="button" className="mini-btn" aria-describedby={`${id}-label`}
            onClick={() => fileInput.current?.click()}>Choose JSON file</button>
  );
  const message = problem || error;
  return (
    <div className="sirdar-secret">
      <span className="field-label" id={`${id}-label`}>{label}</span>
      <div className="sirdar-secret-row">
        <span>{`${label}: ${state}`}</span>
        {!disabled && (action === 'clear'
          ? <button type="button" className="mini-btn" onClick={() => back('keep')}>Undo</button>
          : action === 'set'
            ? <>{choose}<button type="button" className="mini-btn" onClick={() => back('keep')}>Keep</button></>
            : <>{choose}{isSet && <button type="button" className="mini-btn" onClick={() => back('clear')}>Clear</button>}</>)}
      </div>
      {!disabled && (
        <input ref={fileInput} type="file" accept=".json,application/json" hidden data-testid={`${id}-file`}
               onChange={(e) => { void pick(e.target.files?.[0] ?? null); e.target.value = ''; }} />
      )}
      <p className="page-hint">{hint}</p>
      {message && <p className="form-error" role="alert">{message}</p>}
    </div>
  );
}
