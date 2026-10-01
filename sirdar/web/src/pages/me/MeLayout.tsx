/** /me — the signed-in account: hero + Profile / Preferences / History tabs,
 *  the same shape as the portal's My profile page. */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import { avatarGradient, initials } from '@portal/lib/format';
import MePreferences from '@portal/pages/me/MePreferences';

import { errorText, getSirdarProfile, type SirdarProfile } from '../../lib/sirdarApi';
import MeHistory from './MeHistory';
import MeProfile from './MeProfile';

const TABS = [
  ['profile', 'Profile', '/me'],
  ['preferences', 'Preferences', '/me/preferences'],
  ['history', 'History', '/me/history'],
] as const;

type Tab = (typeof TABS)[number][0];

function tabOf(pathname: string): Tab {
  if (pathname.startsWith('/me/preferences')) return 'preferences';
  if (pathname.startsWith('/me/history')) return 'history';
  return 'profile';
}

export default function MeLayout() {
  const { roles } = useAuth();
  const navigate = useNavigate();
  const tab = tabOf(useLocation().pathname);
  const [profile, setProfile] = useState<SirdarProfile | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    getSirdarProfile().then(setProfile)
      .catch((e) => setError(errorText(e, "Couldn't load your profile.")));
  }, []);

  if (!profile) {
    return (
      <div className="portal-page">
        <div className="eyebrow">Account</div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    );
  }

  const place = profile.city ? `${profile.city}${profile.region ? `, ${profile.region}` : ''}` : null;

  return (
    <div className="portal-page">
      <div className="eyebrow">Account</div>

      <div className="profile-hero">
        <div className="profile-cover" />
        <div className="profile-id">
          <div className="profile-photo" aria-hidden="true"
               style={{ background: avatarGradient(profile.display_name) }}>
            {initials(profile.display_name)}
          </div>
          <div className="profile-meta">
            <h1>{profile.display_name}</h1>
            <div className="pm-role">
              {profile.job_title ?? 'No title set'} · {roles.join(', ') || 'no roles'}
            </div>
            <div className="pm-sub">
              {profile.email && <span>✉ {profile.email}</span>}
              {profile.phone && <span>☏ {profile.phone}</span>}
              {place && <span>⌖ {place}</span>}
            </div>
          </div>
          <div className="profile-actions">
            {tab === 'profile' && !editing && (
              <button type="button" className="btn-solid" onClick={() => setEditing(true)}>Edit details</button>
            )}
          </div>
        </div>
      </div>

      <div className="segmented me-tabs" role="tablist">
        {TABS.map(([key, label, to]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key}
                  className={tab === key ? 'on' : ''} onClick={() => navigate(to)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'profile' && (
        <MeProfile profile={profile} onProfile={setProfile} editing={editing} onEditingChange={setEditing} />
      )}
      {tab === 'preferences' && <MePreferences appName="Sirdar" />}
      {tab === 'history' && <MeHistory />}
    </div>
  );
}
