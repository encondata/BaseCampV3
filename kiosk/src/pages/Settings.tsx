/** Kiosk Settings — tabbed sections for Appearance, Sound, Devices, This
 *  Kiosk, Admin, and Developer. The Developer tab, while developer mode
 *  is on, also shows a read-only "Local data" row (the downloaded move's
 *  counts) with a "Clear local data" button. Admin and Developer are hidden (not
 *  disabled) unless the signed-in person holds the level; signed out,
 *  only This Kiosk is visible (see `visibleTabs`). Every tab body but
 *  This Kiosk's is a placeholder for now. The active tab lives in the
 *  `tab` search param, so a link can deep-link straight to a section. */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useKioskAuth } from '../auth/KioskAuthContext';
import LocalDataInspector from '../components/LocalDataInspector';
import { Switch } from '../components/Switch';
import ThisKioskPanel from '../components/ThisKioskPanel';
import { useDevMode } from '../lib/devMode';
import { clearDb } from '../lib/localDb';
import { SETTINGS_TABS, visibleTabs, type SettingsTabId } from '../lib/settingsTabs';
import { SETUP_STATES, setupStateLabel, useKioskSetupState } from '../lib/setupState';
import { formatSyncedAt, resetSyncStatus, useSyncStatus } from '../lib/sync';

const DEFAULT_TAB: SettingsTabId = 'appearance';

export default function Settings() {
  const { status, isAdmin, isDeveloper } = useKioskAuth();
  const signedIn = status === 'authed';
  const [searchParams, setSearchParams] = useSearchParams();
  const [devMode, setDevMode] = useDevMode();
  const [setupState, setSetupState] = useKioskSetupState();
  const sync = useSyncStatus();
  const [clearError, setClearError] = useState(false);

  const clearLocalData = () => {
    setClearError(false);
    clearDb().then(resetSyncStatus).catch(() => setClearError(true));
  };

  const tabs = visibleTabs(SETTINGS_TABS, { isAdmin, isDeveloper, signedIn });
  const requested = searchParams.get('tab');
  const active = tabs.find((t) => t.id === requested) ?? tabs.find((t) => t.id === DEFAULT_TAB) ?? tabs[0];

  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk · Settings</div>
      <h1 className="page-title">Settings</h1>
      <div className="segmented settings-tabs" role="tablist" aria-label="Settings sections">
        {tabs.map((t) => {
          const on = t.id === active.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`settings-tab-${t.id}`}
              aria-selected={on}
              className={on ? 'on' : ''}
              onClick={() => setSearchParams({ tab: t.id }, { replace: true })}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <section role="tabpanel" aria-labelledby={`settings-tab-${active.id}`}>
        <h2 className="settings-tab-title">{active.label}</h2>
        <p className="page-hint">{active.blurb}</p>
        {active.id === 'this-kiosk' && <ThisKioskPanel />}
        {active.id === 'developer' && (
          <div className="settings-row">
            <div>
              <label htmlFor="dev-mode-switch" className="settings-row-label">Developer mode</label>
              <p className="settings-row-hint">
                Shows diagnostics and developer tools on this kiosk. Stored on this kiosk only.
              </p>
            </div>
            <Switch
              id="dev-mode-switch"
              aria-label="Developer mode"
              on={devMode}
              onChange={setDevMode}
            />
          </div>
        )}
        {active.id === 'developer' && devMode && (
          <div className="settings-row">
            <div>
              <span className="settings-row-label">Kiosk setup state</span>
              <p className="settings-row-hint">
                Testing aid until real setup logic sets this. Stored on this kiosk only.
              </p>
            </div>
            <div className="segmented" role="radiogroup" aria-label="Kiosk setup state">
              {SETUP_STATES.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={s === setupState}
                  className={s === setupState ? 'on' : ''}
                  onClick={() => setSetupState(s)}
                >
                  {setupStateLabel(s)}
                </button>
              ))}
            </div>
          </div>
        )}
        {active.id === 'developer' && devMode && (
          <div className="settings-row">
            <div>
              <span className="settings-row-label">Local data</span>
              <p className="settings-row-hint">
                {sync.assets !== undefined && sync.people !== undefined
                  ? `${sync.assets} assets · ${sync.people} people`
                    + (sync.syncedAt ? ` · synced ${formatSyncedAt(sync.syncedAt)}` : '')
                  : 'Nothing downloaded yet.'}
              </p>
              {clearError && (
                <p className="form-error" role="alert">Couldn&apos;t clear local data.</p>
              )}
            </div>
            <button type="button" className="mini-btn" onClick={clearLocalData}>
              Clear local data
            </button>
          </div>
        )}
        {active.id === 'developer' && <LocalDataInspector />}
        {active.id !== 'this-kiosk' && (
          <div className="kiosk-placeholder">
            <p>This section is not available yet.</p>
          </div>
        )}
      </section>
    </div>
  );
}
