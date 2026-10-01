/** This Kiosk — the friendly name (what phones see when linking with this
 *  kiosk), plus read-only identity and config facts. Rendered as the
 *  Settings page's "This Kiosk" tab body (no page chrome of its own — the
 *  Settings page supplies the eyebrow, title, and tabs). Works signed in
 *  or out. */

import { useState, type FormEvent } from 'react';

import { useKioskAuth } from '../auth/KioskAuthContext';
import { apiUrl, kioskVersion, portalUrl } from '../lib/config';
import { ApiError, renameLaptopKiosk } from '../lib/api';
import { getIdentity, setKioskName, setLaptopName } from '../lib/identity';
import { isLaptop, platform } from '../lib/platform';

/** What a refused laptop rename says. */
function renameErrorText(err: unknown): string {
  const code = err instanceof ApiError ? err.code : 'network';
  if (code === 'bad_name') return 'Enter a name between 1 and 80 characters.';
  if (code === 'network' || code === 'edge_offline') {
    return "Can't reach this laptop's edge service. Try again.";
  }
  if (code === 'forbidden' || code === 'not_authenticated') {
    return 'Only an admin can rename this laptop.';
  }
  return `Couldn't rename this laptop (${code}).`;
}

export default function ThisKioskPanel() {
  const { status, heartbeatNow, isAdmin } = useKioskAuth();
  const laptop = isLaptop();
  const canRename = !laptop || (status === 'authed' && isAdmin);
  const [identity, setIdentity] = useState(getIdentity);
  const [name, setName] = useState(identity.name);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (laptop) {
      renameLaptopKiosk(name).then(
        (next) => {
          setLaptopName(next.name);
          setIdentity(getIdentity());
          setError('');
          setSaved(true);
          if (status === 'authed') void heartbeatNow();
        },
        (err) => {
          setSaved(false);
          setError(renameErrorText(err));
        },
      );
      return;
    }
    if (!setKioskName(name)) {
      setError('Enter a name between 1 and 80 characters.');
      setSaved(false);
      return;
    }
    setIdentity(getIdentity());
    setError('');
    setSaved(true);
    if (status === 'authed') void heartbeatNow();
  };

  return (
    <>
      <p className="page-hint">This name is what people see on their phone when they link with this kiosk.</p>
      {!identity.persistent && (
        <div className="portal-banner">
          This browser is keeping neither cookies nor site data for this page, so the
          serial and name reset on every reload — and the portal sees a new kiosk each time.
        </div>
      )}
      <form className="pf-form kiosk-settings" onSubmit={submit} noValidate>
        <div className="full">
          <label htmlFor="ks-name">Kiosk name</label>
          <input id="ks-name" value={name} maxLength={80} readOnly={!canRename}
                 onChange={(e) => { setName(e.target.value); setSaved(false); }} />
          {laptop && !canRename && <p className="page-hint">Only an admin can rename this laptop.</p>}
        </div>
        <div>
          <label htmlFor="ks-serial">Serial</label>
          <input id="ks-serial" className="mono" value={identity.serial} readOnly />
        </div>
        <div>
          <label htmlFor="ks-mode">Mode</label>
          <input id="ks-mode" value={platform().label} readOnly />
        </div>
        <div>
          <label htmlFor="ks-api">API URL</label>
          <input id="ks-api" value={apiUrl()} readOnly />
        </div>
        <div>
          <label htmlFor="ks-portal">Portal URL</label>
          <input id="ks-portal" value={portalUrl()} readOnly />
        </div>
        <div>
          <label htmlFor="ks-version">Version</label>
          <input id="ks-version" value={kioskVersion()} readOnly />
        </div>
        {error && <p className="form-error full" role="alert">{error}</p>}
        {saved && <p className="form-notice full" role="status">Kiosk name saved.</p>}
        <div className="pf-form-actions full">
          {canRename && <button type="submit" className="btn-solid">Save</button>}
        </div>
      </form>
    </>
  );
}
