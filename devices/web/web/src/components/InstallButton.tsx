/** A card's install control, for the device viewing the page:
 *  - an Android app on an Android phone: Install (the APK download);
 *  - an iOS app on an iPhone or iPad: what it can do (ios_state):
 *    Add this iPad / iPhone (not added yet, its registration failed, or it was
 *    disabled), a disabled Preparing… while Apple registration or
 *    re-signing runs, or Install; a build that failed shows only why;
 *  - anywhere else: a QR code that opens this page on the phone. */
import { useState } from 'react';

import StandardModal from '@portal/components/StandardModal';

import { enrollDevice, errorText, installApp, type AppOut } from '../lib/appsApi';
import { goTo } from '../lib/goTo';
import { viewerDevice, viewerPlatform, type ViewerDevice } from '../lib/platform';
import DesktopQr from './DesktopQr';

const NAME_MAX = 60;   // the API's limit on device_name
/** iOS states that adding the device (again) gets past. Re-adding a disabled
 *  one re-enables it only for someone allowed to (the API decides). */
const ADDABLE = new Set(['register_first', 'failed', 'disabled']);

function AddDeviceModal({ device, onClose }: { device: ViewerDevice; onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await enrollDevice(trimmed, device);
      goTo(url);   // the profile download; iOS takes it from here
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <StandardModal
      eyebrow="Devices"
      title={`Add this ${device}`}
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
          <label htmlFor="devices-iphone-name">Name this {device}</label>
          <input id="devices-iphone-name" value={name} maxLength={NAME_MAX} required autoFocus
                 disabled={busy} onChange={(e) => setName(e.target.value)} />
        </div>
        <ol className="full devices-steps">
          <li>Tap Continue, then Allow.</li>
          <li>Open Settings, tap Profile Downloaded, then Install.</li>
          <li>You'll come back here automatically.</li>
        </ol>
        <p className="full page-hint">iOS shows the profile as Not Signed; that's expected.</p>
        {error && <p className="full pf-error">{error}</p>}
      </form>
    </StandardModal>
  );
}

export default function InstallButton({ app, deviceRef, onChanged }: {
  app: AppOut;
  /** This device's registration (ios_devices id), when it was added. */
  deviceRef: string | null;
  /** The app's install state may have moved on (the card reloads). */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (!app.current) return null;
  if (viewerPlatform() !== app.platform) return <DesktopQr />;
  const device = viewerDevice();

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await installApp(app.id, app.platform === 'ios'
        ? { deviceRef, device }
        : {});
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
      {state && ADDABLE.has(state) && (
        <button type="button" className="btn-solid" onClick={() => setAdding(true)}>Add this {device}</button>
      )}
      {(state === 'registering' || state === 'preparing') && (
        <button type="button" className="btn-solid" disabled>Preparing…</button>
      )}
      {state === 'ready' && installButton}
      {error && <p className="pf-error">{error}</p>}
      {adding && <AddDeviceModal device={device} onClose={() => setAdding(false)} />}
    </div>
  );
}
