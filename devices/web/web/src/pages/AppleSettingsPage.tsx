/** Apple settings (roles that may change app distribution): the team's App
 *  Store Connect API key and Apple Distribution certificate. The first save
 *  needs every part; after that the page shows the saved certificate and
 *  key ID, and a file left unpicked (or a password left blank) keeps the
 *  saved one. Nothing secret is ever shown. Clear settings reviews first. */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import StandardModal from '@portal/components/StandardModal';

import { clearApple, errorText, getApple, saveApple, type AppleOut } from '../lib/appsApi';
import { day } from '../lib/dates';

const NOTICE = 'Only one environment may hold these settings. iPhone installs on every other environment point here.';

/** The API's labels (routes/apple.py), in its order. */
const LABELS = {
  team_id: 'Team ID',
  issuer_id: 'Issuer ID',
  key_id: 'Key ID',
  p8: 'API key (.p8)',
  p12: 'Distribution certificate (.p12)',
  p12_password: 'Certificate password',
} as const;
const REPLACE_LABELS = { p8: 'Replace API key (.p8)', p12: 'Replace distribution certificate (.p12)' } as const;

function Frame({ children }: { children?: ReactNode }) {
  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Devices</div>
          <h1 className="page-title">Apple settings</h1>
        </div>
      </div>
      {children}
    </div>
  );
}

export default function AppleSettingsPage() {
  const { can } = useAuth();
  if (!can('app_distribution', 'change')) {
    return (
      <div className="portal-page">
        <div className="eyebrow">Devices</div>
        <h1 className="page-title">You don't have access to Apple settings</h1>
        <p className="page-hint">Ask an administrator for permission to change Apple settings.</p>
      </div>
    );
  }
  return <AppleSettings />;
}

function AppleSettings() {
  const [apple, setApple] = useState<AppleOut | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [savedNote, setSavedNote] = useState(false);

  const load = useCallback(async () => {
    try {
      setApple(await getApple());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <Frame>
      <p className="devices-banner">{NOTICE}</p>
      {apple?.ios_owner_url && (
        <p className="page-hint">
          iPhone installs are set up on <a href={apple.ios_owner_url}>{apple.ios_owner_url}</a>.
        </p>
      )}
      {loadError && <p className="pf-error">{loadError}</p>}
      {apple && (
        <>
          {apple.configured && (
            <dl className="devices-review devices-apple-saved">
              <dt>Certificate</dt><dd>{apple.cert_name}</dd>
              <dt>Expires</dt><dd>{apple.cert_expires_at ? day(apple.cert_expires_at) : '—'}</dd>
              <dt>Key ID</dt><dd>{apple.key_id}</dd>
            </dl>
          )}
          {/* a fresh form once saved or cleared: the first save's picks and the cleared IDs don't linger */}
          <AppleForm key={String(apple.configured)} apple={apple} saved={savedNote}
                     onSaving={() => setSavedNote(false)}
                     onSaved={(next) => { setApple(next); setSavedNote(true); }}
                     onClear={apple.configured ? () => setClearing(true) : null} />
        </>
      )}
      {clearing && (
        <ClearDialog onClose={() => setClearing(false)}
                     onDone={() => { setClearing(false); setSavedNote(false); void load(); }} />
      )}
    </Frame>
  );
}

function AppleForm({ apple, saved, onSaving, onSaved, onClear }: {
  apple: AppleOut; saved: boolean; onSaving: () => void; onSaved: (apple: AppleOut) => void;
  onClear: (() => void) | null;
}) {
  const [teamId, setTeamId] = useState(apple.team_id ?? '');
  const [issuerId, setIssuerId] = useState(apple.issuer_id ?? '');
  const [keyId, setKeyId] = useState(apple.key_id ?? '');
  const [p8, setP8] = useState<File | null>(null);
  const [p12, setP12] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p8Ref = useRef<HTMLInputElement>(null);
  const p12Ref = useRef<HTMLInputElement>(null);
  const hasSaved = apple.configured;
  // the saved password belongs to the saved certificate: asked for with a new one
  const askPassword = !hasSaved || p12 !== null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    onSaving();
    const present: Record<keyof typeof LABELS, boolean> = {
      team_id: !!teamId.trim(), issuer_id: !!issuerId.trim(), key_id: !!keyId.trim(),
      p8: hasSaved || p8 !== null, p12: hasSaved || p12 !== null, p12_password: !askPassword || !!password,
    };
    const missing = (Object.keys(LABELS) as (keyof typeof LABELS)[]).filter((k) => !present[k]).map((k) => LABELS[k]);
    if (missing.length) {
      setError(`Add the missing parts: ${missing.join(', ')}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await saveApple({
        team_id: teamId.trim(), issuer_id: issuerId.trim(), key_id: keyId.trim(), p8, p12,
        p12_password: askPassword ? password : '',
      });
      setBusy(false);
      setP8(null);
      setP12(null);
      setPassword('');
      if (p8Ref.current) p8Ref.current.value = '';
      if (p12Ref.current) p12Ref.current.value = '';
      onSaved(next);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const fileLabel = (name: 'p8' | 'p12') => (hasSaved ? REPLACE_LABELS[name] : LABELS[name]);

  return (
    <form className="pf-form devices-apple-form" onSubmit={(e) => void submit(e)} noValidate>
      <div>
        <label htmlFor="apple-team-id">{LABELS.team_id}</label>
        <input id="apple-team-id" value={teamId} maxLength={200} disabled={busy} autoComplete="off"
               onChange={(e) => setTeamId(e.target.value)} />
      </div>
      <div>
        <label htmlFor="apple-issuer-id">{LABELS.issuer_id}</label>
        <input id="apple-issuer-id" value={issuerId} maxLength={200} disabled={busy} autoComplete="off"
               onChange={(e) => setIssuerId(e.target.value)} />
      </div>
      <div>
        <label htmlFor="apple-key-id">{LABELS.key_id}</label>
        <input id="apple-key-id" value={keyId} maxLength={200} disabled={busy} autoComplete="off"
               onChange={(e) => setKeyId(e.target.value)} />
      </div>
      <div>
        <label htmlFor="apple-p8">{fileLabel('p8')}</label>
        <input id="apple-p8" ref={p8Ref} type="file" accept=".p8" disabled={busy}
               onChange={(e) => setP8(e.target.files?.[0] ?? null)} />
      </div>
      <div>
        <label htmlFor="apple-p12">{fileLabel('p12')}</label>
        <input id="apple-p12" ref={p12Ref} type="file" accept=".p12,.pfx" disabled={busy}
               onChange={(e) => setP12(e.target.files?.[0] ?? null)} />
      </div>
      {askPassword && (
        <div>
          <label htmlFor="apple-p12-password">{LABELS.p12_password}</label>
          <input id="apple-p12-password" type="password" value={password} maxLength={200} disabled={busy}
                 autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
        </div>
      )}
      {error && <p className="full pf-error">{error}</p>}
      {saved && !error && <p className="full page-hint" role="status">Apple settings saved.</p>}
      <div className="pf-form-actions">
        <button type="submit" className="btn-solid" disabled={busy}>{busy ? 'Checking with Apple…' : 'Save'}</button>
        {onClear && (
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClear}>Clear settings</button>
        )}
      </div>
    </form>
  );
}

/** The review before clearing: what goes, then the action. */
function ClearDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await clearApple();
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <StandardModal
      eyebrow="Devices" title="Clear Apple settings?"
      description="The API key, the certificate and its password are removed from this environment. iPhones can't install or update apps from here until the settings are saved again."
      onClose={onClose} busy={busy} cardClass="devices-modal devices-modal-narrow"
      footer={(
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-solid btn-danger" disabled={busy} onClick={() => void go()}>Clear settings</button>
        </>
      )}
    >
      {error && <p className="pf-error">{error}</p>}
    </StandardModal>
  );
}
