import { useRef, useState, type ReactNode } from 'react';

import { errorDetail, errorText, trustKnownHost } from '../lib/sirdarApi';

import HostKeyModal from './HostKeyModal';

export interface HostKeyInfo {
  host: string; port: number; key_type: string; fingerprint?: string; expected?: string; actual?: string;
}

/** The host-key half of an action that SSHes to `target`. `handle(err)` takes
 *  over host_key_unknown (shows HostKeyModal; trusting retries through
 *  `onTrusted`) and host_key_mismatch (a message for `onProblem`), and says
 *  whether it did. The caller renders `modal`. */
export function useHostKeyTrust({ target, canTrust, trustLabel, onTrusted, onProblem }: {
  target: string; canTrust: boolean; trustLabel: string;
  onTrusted: () => void; onProblem: (message: string) => void;
}): { handle: (err: unknown) => boolean; open: boolean; modal: ReactNode } {
  const [unknown, setUnknown] = useState<HostKeyInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef({ onTrusted, onProblem });
  latest.current = { onTrusted, onProblem };

  const handle = (err: unknown): boolean => {
    const code = (err as { code?: string }).code;
    const d = errorDetail<HostKeyInfo>(err);
    if (code === 'host_key_unknown' && d) { setError(''); setUnknown(d); return true; }
    if (code === 'host_key_mismatch' && d) {
      latest.current.onProblem(`The key of ${d.host}:${d.port} doesn't match the one Sirdar trusted. `
        + 'Check the server, then forget the old key under Trusted SSH hosts on the Deploy page.');
      return true;
    }
    return false;
  };

  const trust = async () => {
    if (!unknown?.fingerprint) return;
    setBusy(true); setError('');
    try {
      if (target.startsWith('ssh:')) await trustKnownHost(unknown.host, unknown.port, unknown.fingerprint, target);
      else await trustKnownHost(unknown.host, unknown.port, unknown.fingerprint);
    } catch (e) {
      setBusy(false);
      if ((e as { code?: string }).code === 'host_key_changed') {
        setUnknown(null);
        latest.current.onProblem("The server's key changed while you were looking. Try again.");
        return;
      }
      setError(errorText(e, "Couldn't trust this server."));
      return;
    }
    setBusy(false);
    setUnknown(null);
    latest.current.onTrusted();
  };

  const modal = unknown ? (
    <HostKeyModal host={unknown.host} port={unknown.port} keyType={unknown.key_type}
                  fingerprint={unknown.fingerprint ?? ''} canTrust={canTrust} busy={busy} error={error}
                  trustLabel={trustLabel} onTrust={trust} onCancel={() => setUnknown(null)} />
  ) : null;
  return { handle, open: unknown !== null, modal };
}
