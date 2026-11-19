/** Apps (home): one card per app and platform, with the install control
 *  for the device viewing it. Coming back from adding an iPhone
 *  (`?added=<device ref>`), the page remembers which iPhone this is and
 *  polls while Apple registration or re-signing runs. Admins get the
 *  Upload button and a warning when Apple signing is about to expire. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import AppCard from '../components/AppCard';
import UploadModal from '../components/UploadModal';
import { errorText, getApple, listApps, type AppleOut, type AppOut } from '../lib/appsApi';
import { day } from '../lib/dates';
import { readDeviceRef, storeDeviceRef } from '../lib/deviceRef';

const POLL_MS = 5_000;
const POLL_FOR_MS = 10 * 60_000;
const WARN_WITHIN_MS = 30 * 86_400_000;

/** An iOS card waiting on Apple registration or re-signing, or on a retry
 *  of either after a failure. */
const waiting = (app: AppOut) => {
  const ios = app.ios_state;
  return ios?.state === 'registering' || ios?.state === 'preparing' || ios?.retrying === true;
};

function expiryWarnings(apple: AppleOut, now: number): string[] {
  const soon = (iso: string | null): iso is string => !!iso && Date.parse(iso) - now <= WARN_WITHIN_MS;
  const verb = (iso: string) => (Date.parse(iso) < now ? 'expired' : 'expires');
  const out: string[] = [];
  if (soon(apple.cert_expires_at)) {
    out.push(`The Apple Distribution certificate ${verb(apple.cert_expires_at)} on ${day(apple.cert_expires_at)}.`);
  }
  for (const p of apple.profiles) {
    if (soon(p.expires_at)) out.push(`The ${p.app_name} profile ${verb(p.expires_at)} on ${day(p.expires_at)}.`);
  }
  return out;
}

export default function AppsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const added = params.get('added');
  const [deviceRef] = useState(() => added ?? readDeviceRef());
  const [apps, setApps] = useState<AppOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [loads, setLoads] = useState(0);   // answers so far, failed ones too
  const pollUntil = useRef(Date.now() + POLL_FOR_MS);
  const latest = useRef(0);   // only the newest answer lands
  const canChange = can('app_distribution', 'change');

  // back from adding an iPhone: remember it, and drop ?added from the address
  useEffect(() => {
    if (!added) return;
    storeDeviceRef(added);
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete('added');
      return next;
    }, { replace: true });
  }, [added, setParams]);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    try {
      const list = await listApps(deviceRef);
      if (seq !== latest.current) return;
      setApps(list);
      setError(null);
    } catch (err) {
      if (seq === latest.current) setError(errorText(err));
    } finally {
      if (seq === latest.current) setLoads((n) => n + 1);
    }
  }, [deviceRef]);

  /** Something changed here (an upload, an install that isn't ready):
   *  load again, and keep polling for another 10 minutes. */
  const refresh = useCallback(() => {
    pollUntil.current = Date.now() + POLL_FOR_MS;
    void load();
  }, [load]);

  useEffect(() => { void load(); }, [load]);

  // poll while an iPhone registers or an app is re-signed, for 10 minutes
  // (after each answer, so a failed look doesn't end it)
  useEffect(() => {
    if (!apps?.some(waiting) || Date.now() >= pollUntil.current) return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [apps, loads, load]);

  // admins only: Apple's certificate and profiles expiring within 30 days
  useEffect(() => {
    if (!canChange) return;
    let live = true;
    getApple()
      .then((apple) => { if (live) setWarnings(expiryWarnings(apple, Date.now())); })
      .catch(() => {});   // the warning is a courtesy; Apple settings shows the details
    return () => { live = false; };
  }, [canChange]);

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Devices</div>
          <h1 className="page-title">Apps</h1>
        </div>
        {can('app_distribution', 'add') && (
          <button type="button" className="btn-solid" onClick={() => setUploading(true)}>Upload</button>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="devices-banner" role="status">
          {warnings.map((w) => <p key={w}>{w}</p>)}
        </div>
      )}
      {error && <p className="pf-error">{error}</p>}

      {apps === null ? (
        !error && <p className="page-hint">Loading…</p>
      ) : apps.length === 0 ? (
        <p className="page-hint">No apps yet.</p>
      ) : (
        <div className="devices-cards">
          {apps.map((app) => <AppCard key={app.id} app={app} deviceRef={deviceRef} onChanged={refresh} />)}
        </div>
      )}

      {uploading && (
        <UploadModal onClose={() => setUploading(false)}
                     onSaved={() => { setUploading(false); refresh(); }} />
      )}
    </div>
  );
}
