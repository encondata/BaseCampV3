/** This laptop's network: the wired status, then the Wi-Fi networks to join
 *  (NetworkManager, through the kiosk helper). A secured network takes its
 *  password in the pinned footer, next to Join, so it never scrolls away.
 *  The password goes to the helper and on to nmcli's stdin, nowhere else.
 *  An empty one uses a network the laptop already knows. */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { getWifiNetworks, HelperError, joinWifi, type WifiNetwork, type Wired } from '../../lib/hostHelper';
import { ChoiceCard } from '../printers/ChoiceCard';

export const WIFI_LIST_MS = 15_000;   // assumption

function wiredText(wired: Wired | null): string {
  if (!wired) return 'No wired adapter';
  return `${wired.connected ? 'Connected' : 'Not connected'} (${wired.device})`;
}

function describe(n: WifiNetwork): string {
  return `${n.signal}% signal · ${n.secure ? 'Secured' : 'Open'}${n.active ? ' · Connected' : ''}`;
}

function joinErrorText(code: string, ssid: string): string {
  switch (code) {
    case 'wrong_password': return `Couldn't join ${ssid}. Check the password and try again.`;
    case 'password_required': return `${ssid} needs a password.`;
    case 'not_found': return `${ssid} is out of range.`;
    case 'unreachable': return "Couldn't reach the kiosk helper on this laptop. Try again.";
    default: return `Couldn't join ${ssid}.`;
  }
}

export default function NetworkModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [networks, setNetworks] = useState<WifiNetwork[] | null>(null);
  const [wired, setWired] = useState<Wired | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const live = useRef(true);

  const load = useCallback(async () => {
    try {
      const out = await getWifiNetworks();
      if (!live.current) return;
      setNetworks(out.networks);
      setWired(out.wired);
      setListFailed(false);
    } catch {
      if (live.current) setListFailed(true);
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void load();
    const timer = setInterval(() => void load(), WIFI_LIST_MS);
    return () => { live.current = false; clearInterval(timer); };
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const pick = networks?.find((n) => n.ssid === selected) ?? null;

  const choose = (ssid: string) => {
    setSelected(ssid);
    setPassword('');
    setError(null);
    setNote(null);
  };

  const join = (e: FormEvent) => {
    e.preventDefault();
    if (!pick || pick.active || busy) return;
    const ssid = pick.ssid;
    setBusy(true);
    setError(null);
    setNote(null);
    joinWifi(ssid, pick.secure ? password : '').then(
      () => {
        if (!live.current) return;
        setBusy(false);
        setPassword('');
        setNote(`Connected to ${ssid}.`);
        onChanged();
        void load();
      },
      (err: unknown) => {
        if (!live.current) return;
        setBusy(false);
        const code = err instanceof HelperError ? err.code : 'failed';
        setPassword('');   // the password is never kept after its request, whatever the answer
        setError(joinErrorText(code, ssid));
      },
    );
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form className="modal-card reports-modal-card rgm-card confirm-card" role="dialog" aria-modal="true"
            aria-label="Network" onSubmit={join} noValidate>
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">This laptop</div>
            <h3>Network</h3>
            <p className="page-hint">Pick a Wi-Fi network to join.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-section">Wired</div>
          <p className="page-hint">{networks === null && !listFailed ? 'Checking…' : wiredText(wired)}</p>
          <div className="modal-section">Wi-Fi</div>
          {networks === null && !listFailed && <p className="page-hint">Looking for Wi-Fi networks…</p>}
          {listFailed && networks === null && (
            <p className="page-hint">Couldn&apos;t read the Wi-Fi networks. Trying again…</p>
          )}
          {networks?.length === 0 && <p className="page-hint">No Wi-Fi networks found.</p>}
          {networks && networks.length > 0 && (
            <div className="rgm-choice-cards" role="radiogroup" aria-label="Wi-Fi networks">
              {networks.map((n) => (
                <ChoiceCard key={n.ssid} title={n.ssid} description={describe(n)}
                            selected={selected === n.ssid} onSelect={() => choose(n.ssid)} />
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <div className="kiosk-net-foot">
            {pick?.secure && !pick.active && (
              <div className="pf-form kiosk-wifi-pass">
                <label htmlFor="kiosk-wifi-pass">Password</label>
                <input id="kiosk-wifi-pass" type="password" autoComplete="new-password" spellCheck={false}
                       maxLength={128} value={password} disabled={busy}
                       onChange={(e) => setPassword(e.target.value)} />
              </div>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
            {note && <p className="form-notice" role="status">{note}</p>}
          </div>
          <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Close</button>
          <button type="submit" className="btn-solid" disabled={!pick || pick.active || busy}>
            {busy ? 'Joining…' : 'Join'}
          </button>
        </div>
      </form>
    </div>
  );
}
