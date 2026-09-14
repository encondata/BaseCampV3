/** Kiosk Settings — tabbed sections for Appearance, Sound, Devices, This
 *  Kiosk, Admin, and Developer. The Developer tab, while developer mode
 *  is on, also shows a read-only "Local data" row (the downloaded move's
 *  counts) with a "Clear local data" button. Admin and Developer are hidden (not
 *  disabled) unless the signed-in person holds the level; signed out,
 *  only This Kiosk is visible (see `visibleTabs`). Appearance owns the two
 *  scan-flash colors (kiosk-local HSL); every tab body but those two is
 *  a placeholder for now. The active tab lives in the
 *  `tab` search param, so a link can deep-link straight to a section. */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useKioskAuth } from '../auth/KioskAuthContext';
import HslPicker from '../components/HslPicker';
import LocalDataInspector from '../components/LocalDataInspector';
import SoundPanel from '../components/SoundPanel';
import { Switch } from '../components/Switch';
import ThisKioskPanel from '../components/ThisKioskPanel';
import { FLASH_MS_RANGE, useAppearance } from '../lib/appearance';
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
  const [appearance, setAppearance] = useAppearance();
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
        {active.id === 'appearance' && (
          <>
            <div className="settings-row">
              <div>
                <span className="settings-row-label">Good scan flash</span>
                <p className="settings-row-hint">
                  The color the whole screen flashes when a scan matches this kiosk&apos;s
                  local move data. Stored on this kiosk only.
                </p>
              </div>
              <HslPicker
                name="Good scan flash"
                value={appearance.good_scan}
                onChange={(good_scan) => setAppearance({ good_scan })}
                flashMs={appearance.flash_ms}
              />
            </div>
            <div className="settings-row">
              <div>
                <span className="settings-row-label">Not-found scan flash</span>
                <p className="settings-row-hint">
                  The color the whole screen flashes when a scan matches nothing.
                  Stored on this kiosk only.
                </p>
              </div>
              <HslPicker
                name="Not-found scan flash"
                value={appearance.not_found_scan}
                onChange={(not_found_scan) => setAppearance({ not_found_scan })}
                flashMs={appearance.flash_ms}
              />
            </div>
            <div className="settings-row">
              <div>
                <span className="settings-row-label">Flash duration</span>
                <p className="settings-row-hint">
                  How long the screen flashes after a scan.
                </p>
              </div>
              <label className="flash-ms">
                <input
                  type="range"
                  min={FLASH_MS_RANGE.min}
                  max={FLASH_MS_RANGE.max}
                  step={FLASH_MS_RANGE.step}
                  value={appearance.flash_ms}
                  aria-label="Flash duration"
                  onChange={(e) => setAppearance({ flash_ms: Number(e.target.value) })}
                />
                <span className="flash-ms-value mono">{`${appearance.flash_ms} ms`}</span>
              </label>
            </div>
          </>
        )}
        {active.id === 'sound' && <SoundPanel />}
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
        {active.id !== 'this-kiosk' && active.id !== 'appearance' && active.id !== 'sound' && (
          <div className="kiosk-placeholder">
            <p>This section is not available yet.</p>
          </div>
        )}
      </section>
    </div>
  );
}
