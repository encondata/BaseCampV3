import { useEffect } from 'react';

export default function HostKeyModal({ host, port, keyType, fingerprint, canTrust, busy, error, onTrust, onCancel }: {
  host: string; port: number; keyType: string; fingerprint: string;
  canTrust: boolean; busy: boolean; error: string;
  onTrust: () => void; onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-hostkey-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-hostkey-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">SSH</div>
            <h3 id="sirdar-hostkey-title">Trust this server?</h3>
            <p className="page-hint">
              First time connecting to {host}:{port}. Check this fingerprint with the server's
              administrator before trusting it.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onCancel}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <dl className="sirdar-kv">
            <dt>Key type</dt><dd className="mono">{keyType}</dd>
            <dt>Fingerprint</dt><dd className="mono sirdar-fingerprint">{fingerprint}</dd>
          </dl>
          {!canTrust && (
            <p className="page-hint">
              You can't trust new servers. Ask someone with permission to change deployments.
            </p>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn-solid" disabled={!canTrust || busy} onClick={onTrust}>
            Trust and connect
          </button>
        </div>
      </div>
    </div>
  );
}
