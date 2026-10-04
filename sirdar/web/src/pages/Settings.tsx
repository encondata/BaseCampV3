import { useEffect, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import { errorText, getSettings, type SirdarSettings } from '../lib/sirdarApi';

import IntegrationsSection from './settings/IntegrationsSection';

const minutes = (s: number) => `${Math.round(s / 60)} min`;

export default function Settings() {
  const { can } = useAuth();
  const [s, setS] = useState<SirdarSettings | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { getSettings().then(setS).catch((e) => setError(errorText(e, "Couldn't load settings."))); }, []);
  return (
    <div className="portal-page">
      <div className="eyebrow">System</div>
      <div className="dir-head">
        <h1>Settings</h1>
        <p>How this Sirdar is configured. The values below come from the server's environment.</p>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {s && (
        <div className="sirdar-kv">
          <span>Environment</span><span>{s.env}</span>
          <span>Portal database</span><span>{s.source_configured ? 'Configured' : 'Not configured'}</span>
          <span>Session lifetime</span><span>{Math.round(s.session_ttl_seconds / 3600)} h</span>
          <span>Access token lifetime</span><span>{minutes(s.access_token_ttl_seconds)}</span>
          <span>Lockout</span><span>{s.max_failed_logins} failures → {minutes(s.lockout_seconds)}</span>
        </div>
      )}
      {can('deploy', 'view') && <IntegrationsSection />}
    </div>
  );
}
