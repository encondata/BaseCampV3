/**
 * BackupCodesPanel — the one-time recovery codes, shown exactly once.
 * Copy / Download unlock the acknowledge button (or a 5 s timer does, for
 * people who photograph the screen).
 */
import { useEffect, useState } from 'react';

export default function BackupCodesPanel({ codes, onAcknowledged, ackLabel = "I've saved my codes" }: {
  codes: string[];
  onAcknowledged: () => void;
  ackLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setSaved(true), 5000);
    return () => window.clearTimeout(t);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch { /* clipboard blocked — the codes are still on screen */ }
    setSaved(true);
  };

  const download = () => {
    const blob = new Blob([
      'ServerSherpa two-factor backup codes\nEach code works once. Keep them somewhere safe.\n\n',
      codes.join('\n'), '\n',
    ], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'serversherpa-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };

  return (
    <>
      <p className="otp-info notice">These codes each work once if you lose your phone. This is the only time they are shown.</p>
      <div className="backup-grid">
        {codes.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div className="otp-actions">
        <button type="button" className="btn-sso" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
        <button type="button" className="btn-sso" onClick={download}>Download</button>
      </div>
      <button type="button" className="btn otp-verify" disabled={!saved} onClick={onAcknowledged}>
        <span>{ackLabel}</span>
      </button>
    </>
  );
}
