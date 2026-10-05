/** The trust-on-first-use prompt for a VM host's TLS certificate (Proxmox,
 *  ESXi): a new certificate to compare with the host's own, or a changed one
 *  to trust only if it was renewed on purpose. The modal keeps the request
 *  that asked (`what`) and resends it with the trusted fingerprint. */
import { errorDetail, type TlsCertificate } from '../lib/sirdarApi';
import { when } from '../pages/environments/labels';

export type PendingCertificate<W> = { kind: 'untrusted'; what: W; cert: TlsCertificate }
  | { kind: 'changed'; what: W; expected: string; actual: string };

/** tls_untrusted / tls_mismatch from a save or test, as a pending prompt; null
 *  for anything else, including one without the certificate's details (the
 *  caller then shows the code's message instead). */
export function pendingCertificate<W>(err: unknown, what: W): PendingCertificate<W> | null {
  const code = (err as { code?: string } | null)?.code ?? '';
  const d = errorDetail<Record<string, unknown>>(err);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  if (code === 'tls_untrusted' && d && typeof d.fingerprint === 'string') {
    const names = Array.isArray(d.names) ? d.names.map(String) : [];
    return { kind: 'untrusted', what, cert: {
      fingerprint: d.fingerprint, subject: str(d.subject), issuer: str(d.issuer), not_after: str(d.not_after), names,
    } };
  }
  if (code === 'tls_mismatch' && d && typeof d.expected === 'string' && typeof d.actual === 'string') {
    return { kind: 'changed', what, expected: d.expected, actual: d.actual };
  }
  return null;
}

export default function CertificatePrompt<W>({ pending, question, busy, onTrust }: {
  pending: PendingCertificate<W>; question: string; busy: boolean; onTrust: (fingerprint: string, what: W) => void;
}) {
  return (
    <div className="sirdar-span2 sirdar-cert-prompt" role="group" aria-label="Server certificate">
      {pending.kind === 'untrusted' ? (
        <>
          <p>{question}</p>
          <dl className="sirdar-kv">
            <dt>SHA-256 fingerprint</dt><dd className="mono sirdar-fingerprint">{pending.cert.fingerprint}</dd>
            <dt>Subject</dt><dd>{pending.cert.subject || '—'}</dd>
            <dt>Issued by</dt><dd>{pending.cert.issuer || '—'}</dd>
            <dt>Expires</dt><dd className="mono">{when(pending.cert.not_after)}</dd>
            <dt>Names</dt><dd className="mono">{pending.cert.names.join(', ') || '—'}</dd>
          </dl>
          <button type="button" className="btn-solid" disabled={busy}
                  onClick={() => onTrust(pending.cert.fingerprint, pending.what)}>Trust this certificate</button>
        </>
      ) : (
        <>
          <p className="form-error">
            The server's certificate changed. Trust the new one only if it was renewed on purpose.
          </p>
          <dl className="sirdar-kv">
            <dt>Trusted</dt><dd className="mono sirdar-fingerprint">{pending.expected}</dd>
            <dt>Now</dt><dd className="mono sirdar-fingerprint">{pending.actual}</dd>
          </dl>
          <button type="button" className="btn-ghost" disabled={busy}
                  onClick={() => onTrust(pending.actual, pending.what)}>Trust the new certificate</button>
        </>
      )}
    </div>
  );
}
