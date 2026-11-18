/** A card's install control, for the device viewing the page:
 *  - an Android app on an Android phone: Install (the APK download);
 *  - an iOS app on an iPhone or iPad: what the phone can do (ios_state):
 *    Add this iPhone, a disabled Preparing… while Apple registration or
 *    re-signing runs, or Install;
 *  - anywhere else: a QR code that opens this page on the phone. */
import { useState } from 'react';

import StandardModal from '@portal/components/StandardModal';

import { enrollIphone, errorText, installApp, type AppOut } from '../lib/appsApi';
import { goTo } from '../lib/goTo';
import { viewerPlatform } from '../lib/platform';
import DesktopQr from './DesktopQr';

const NAME_MAX = 60;   // the API's limit on device_name

function AddIphoneModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await enrollIphone(trimmed);
      goTo(url);   // the profile download; iOS takes it from here
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <StandardModal
      eyebrow="Devices"
      title="Add this iPhone"
      onClose={onClose}
      busy={busy}
      cardClass="devices-modal devices-modal-narrow"
      footer={(
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="devices-add-iphone" className="btn-solid" disabled={!trimmed || busy}>
            {busy ? 'Continuing…' : 'Continue'}
          </button>
        </>
      )}
    >
      <form id="devices-add-iphone" className="pf-form devices-form"
            onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="full">
          <label htmlFor="devices-iphone-name">Name this iPhone</label>
          <input id="devices-iphone-name" value={name} maxLength={NAME_MAX} required autoFocus
                 disabled={busy} onChange={(e) => setName(e.target.value)} />
        </div>
        <ol className="full devices-steps">
          <li>Tap Continue, then Allow.</li>
          <li>Open Settings, tap Profile Downloaded, then Install.</li>
          <li>You'll come back here automatically.</li>
        </ol>
        <p className="full page-hint">iOS shows the profile as Not Verified; that's expected.</p>
        {error && <p className="full pf-error">{error}</p>}
      </form>
    </StandardModal>
  );
}

export default function InstallButton({ app, deviceRef, onChanged }: {
  app: AppOut;
  /** This iPhone's registration (ios_devices id), when it was added. */
  deviceRef: string | null;
  /** The app's install state may have moved on (the card reloads). */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (!app.current) return null;
  if (viewerPlatform() !== app.platform) return <DesktopQr />;

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await installApp(app.id, { deviceRef: app.platform === 'ios' ? deviceRef : null });
      if ('url' in result) goTo(result.url);
      else onChanged();   // iOS: not ready after all; the card shows why
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const installButton = (
    <button type="button" className="btn-solid" disabled={busy} onClick={() => void install()}>Install</button>
  );

  if (app.platform === 'android') {
    return (
      <div className="devices-install">
        {installButton}
        <p className="page-hint">Got it from Google Play? Uninstall it first.</p>
        {error && <p className="pf-error">{error}</p>}
      </div>
    );
  }

  const ios = app.ios_state;
  const state = ios?.state;
  return (
    <div className="devices-install">
      {ios?.message && <p className="page-hint">{ios.message}</p>}
      {state === 'register_first' && (
        <button type="button" className="btn-solid" onClick={() => setAdding(true)}>Add this iPhone</button>
      )}
      {(state === 'registering' || state === 'preparing') && (
        <button type="button" className="btn-solid" disabled>Preparing…</button>
      )}
      {state === 'ready' && installButton}
      {error && <p className="pf-error">{error}</p>}
      {adding && <AddIphoneModal onClose={() => setAdding(false)} />}
    </div>
  );
}
