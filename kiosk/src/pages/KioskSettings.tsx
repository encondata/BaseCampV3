/** Kiosk settings — the friendly name (what phones see when linking),
 *  plus read-only identity and config facts. Works signed in or out. */

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { useKioskAuth } from '../auth/KioskAuthContext';
import { apiUrl, kioskVersion, portalUrl } from '../lib/config';
import { getIdentity, setKioskName } from '../lib/identity';
import { platform } from '../lib/platform';

export default function KioskSettings() {
  const { status, heartbeatNow } = useKioskAuth();
  const navigate = useNavigate();
  const [identity, setIdentity] = useState(getIdentity);
  const [name, setName] = useState(identity.name);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
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
    <div className="portal-page">
      <div className="eyebrow">Kiosk</div>
      <h1 className="page-title">Kiosk settings</h1>
      <p className="page-hint">This name is what people see on their phone when they link with this kiosk.</p>
      {!identity.persistent && (
        <div className="portal-banner">
          This browser can&apos;t remember kiosk settings. The serial and name reset when the page reloads.
        </div>
      )}
      <form className="pf-form kiosk-settings" onSubmit={submit} noValidate>
        <div className="full">
          <label htmlFor="ks-name">Kiosk name</label>
          <input id="ks-name" value={name} maxLength={80}
                 onChange={(e) => { setName(e.target.value); setSaved(false); }} />
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
          <button type="button" className="mini-btn" onClick={() => navigate(-1)}>Back</button>
          <button type="submit" className="btn-solid">Save</button>
        </div>
      </form>
    </div>
  );
}
