/** Placeholder home — scanning lands in a later update. Shows enough to
 *  confirm who and what is signed in. */

import { registrationLabel } from '@portal/lib/devices';

import { useKioskAuth } from '../auth/KioskAuthContext';
import { getIdentity } from '../lib/identity';
import { platform } from '../lib/platform';

export default function Home() {
  const { person, registration, sessionExpiresAt } = useKioskAuth();
  const identity = getIdentity();
  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk</div>
      <h1 className="page-title">Ready</h1>
      <p className="page-hint">Scanning arrives in a later update.</p>
      <dl className="kiosk-facts">
        <div><dt>Kiosk</dt><dd>{identity.name}</dd></div>
        <div><dt>Mode</dt><dd>{platform().label}</dd></div>
        <div><dt>Signed in as</dt><dd>{person?.display_name ?? '—'}</dd></div>
        <div><dt>Session ends</dt><dd>{sessionExpiresAt ? new Date(sessionExpiresAt).toLocaleString() : '—'}</dd></div>
        <div><dt>Registration</dt><dd>{registration ? registrationLabel(registration) : 'Checking…'}</dd></div>
      </dl>
    </div>
  );
}
