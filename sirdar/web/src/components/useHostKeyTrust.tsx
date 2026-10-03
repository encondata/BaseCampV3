import { useRef, useState, type ReactNode } from 'react';

import { errorDetail, errorText, trustKnownHost } from '../lib/sirdarApi';

import HostKeyModal from './HostKeyModal';

export interface HostKeyInfo {
  host: string; port: number; key_type: string; fingerprint?: string; expected?: string; actual?: string;
}

/** The host-key half of an action that SSHes to a target. `handle(err, target, attempt)`
 *  takes over host_key_unknown (shows HostKeyModal) and host_key_mismatch (a
 *  message for `onProblem`), and says whether it did. It snapshots the failed
 *  attempt: trusting records the fingerprint against that attempt's `target`
 *  and then hands the same `attempt` back to `onTrusted` to retry, so edits
 *  made while the modal is open can't redirect the trust or the retry. The
 *  caller renders `modal` and should make its own form inert while `open`. */
export function useHostKeyTrust<A>({ canTrust, trustLabel, onTrusted, onProblem }: {
  canTrust: boolean; trustLabel: string;
  onTrusted: (attempt: A) => void; onProblem: (message: string) => void;
}): { handle: (err: unknown, target: string, attempt: A) => boolean; open: boolean; modal: ReactNode } {
  const [pending, setPending] = useState<{ info: HostKeyInfo; target: string; attempt: A } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef({ onTrusted, onProblem });
  latest.current = { onTrusted, onProblem };

  const handle = (err: unknown, target: string, attempt: A): boolean => {
    const code = (err as { code?: string }).code;
    const d = errorDetail<HostKeyInfo>(err);
    if (code === 'host_key_unknown' && d) { setError(''); setPending({ info: d, target, attempt }); return true; }
    if (code === 'host_key_mismatch' && d) {
      latest.current.onProblem(`The key of ${d.host}:${d.port} doesn't match the one Sirdar trusted. `
        + 'Check the server, then forget the old key under Trusted SSH hosts on the Deploy page.');
      return true;
    }
    return false;
  };

  const trust = async () => {
    const fingerprint = pending?.info.fingerprint;
    if (!pending || !fingerprint) return;
    const { info, target, attempt } = pending;
    setBusy(true); setError('');
    try {
      if (target.startsWith('ssh:')) await trustKnownHost(info.host, info.port, fingerprint, target);
      else await trustKnownHost(info.host, info.port, fingerprint);
    } catch (e) {
      setBusy(false);
      if ((e as { code?: string }).code === 'host_key_changed') {
        setPending(null);
        latest.current.onProblem("The server's key changed while you were looking. Try again.");
        return;
      }
      setError(errorText(e, "Couldn't trust this server."));
      return;
    }
    setBusy(false);
    setPending(null);
    latest.current.onTrusted(attempt);
  };

  const modal = pending ? (
    <HostKeyModal host={pending.info.host} port={pending.info.port} keyType={pending.info.key_type}
                  fingerprint={pending.info.fingerprint ?? ''} canTrust={canTrust} busy={busy} error={error}
                  trustLabel={trustLabel} onTrust={trust} onCancel={() => setPending(null)} />
  ) : null;
  return { handle, open: pending !== null, modal };
}
