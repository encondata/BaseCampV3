/**
 * Settings → Administration: read-only maintenance mode (+ pause workers,
 * resume) and the broadcast banner. Switches PUT immediately; message
 * fields save via an explicit Save that appears when dirty. Every
 * successful write nudges the public status so the banners update at
 * once instead of on the next 60s poll.
 */
import { useEffect, useState } from 'react';

import {
  ApiError, getAdminConfig, refreshSystemStatus, updateAdminConfig,
} from '../../lib/api';
import type { AdminConfig } from '../../lib/api';
import { Switch } from '../Switch';

const ERRORS: Record<string, string> = {
  banner_message_required: 'Enter a message first.',
};

function describe(err: unknown): string {
  const code = err instanceof ApiError ? err.code : '';
  return ERRORS[code] ?? 'Could not save — try again.';
}

export default function AdminControls() {
  const [cfg, setCfg] = useState<AdminConfig | null>(null);
  const [readOnlyDraft, setReadOnlyDraft] = useState('');
  const [bannerDraft, setBannerDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getAdminConfig().then((c) => {
      setCfg(c);
      setReadOnlyDraft(c.read_only_message);
      setBannerDraft(c.banner_message);
    }).catch((e: unknown) => setError(describe(e)));
  }, []);

  const apply = async (patch: Partial<AdminConfig>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await updateAdminConfig(patch);
      setCfg(next);
      // Only resync the draft for a message this write actually saved —
      // otherwise toggling a switch would discard an unsaved message the
      // admin is still typing in the other field.
      if ('read_only_message' in patch) setReadOnlyDraft(next.read_only_message);
      if ('banner_message' in patch) setBannerDraft(next.banner_message);
      refreshSystemStatus();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleBanner = (on: boolean) => {
    if (on && !bannerDraft.trim()) {
      setError('Enter a message first.');
      return;
    }
    void apply(on ? { banner_enabled: true, banner_message: bannerDraft.trim() }
                  : { banner_enabled: false });
  };

  if (!cfg) return <p className="set-note">{error ?? 'Loading…'}</p>;
  const readOnlyDirty = readOnlyDraft.trim() !== cfg.read_only_message;
  const bannerDirty = bannerDraft.trim() !== cfg.banner_message;
  const paused = cfg.read_only && cfg.pause_workers;

  return (
    <>
      <div className="set-row">
        <div className="set-label">
          <b>Read-only maintenance mode</b>
          <span>Freeze all writes across the portal during cutovers. Developers stay exempt.</span>
          <div className="set-inline">
            <input value={readOnlyDraft} maxLength={300}
                   placeholder="Shown to everyone in the banner, e.g. 'Cutover in progress until 14:00 ET'"
                   onChange={(e) => setReadOnlyDraft(e.target.value)} />
            {readOnlyDirty && (
              <button className="mini-btn" type="button" disabled={busy}
                      onClick={() => void apply({ read_only_message: readOnlyDraft.trim() })}>
                Save
              </button>
            )}
          </div>
        </div>
        <Switch checked={cfg.read_only} disabled={busy}
                onChange={(v) => void apply({ read_only: v })} />
      </div>
      <div className="set-row set-subrow">
        <div className="set-label">
          <b>Also pause background services</b>
          <span>
            {paused
              ? 'Workers idle while paused; resume lifts the pause within a few seconds.'
              : 'Scan matching, imports and notifications idle while read-only mode is on.'}
          </span>
          {paused && (
            <div className="set-inline">
              <button className="mini-btn" type="button" disabled={busy}
                      onClick={() => void apply({ pause_workers: false })}>
                Resume workers
              </button>
            </div>
          )}
        </div>
        <Switch checked={cfg.pause_workers} disabled={busy || !cfg.read_only}
                onChange={(v) => void apply({ pause_workers: v })} />
      </div>
      <div className="set-row">
        <div className="set-label">
          <b>Broadcast banner</b>
          <span>Show an announcement to everyone — on the login page and inside the portal.</span>
          <div className="set-inline">
            <input value={bannerDraft} maxLength={300}
                   placeholder="e.g. 'Scheduled maintenance Saturday 02:00–04:00 ET'"
                   onChange={(e) => setBannerDraft(e.target.value)} />
            {bannerDirty && cfg.banner_enabled && (
              <button className="mini-btn" type="button" disabled={busy}
                      onClick={() => void apply({ banner_message: bannerDraft.trim() })}>
                Save
              </button>
            )}
          </div>
        </div>
        <Switch checked={cfg.banner_enabled} disabled={busy} onChange={toggleBanner} />
      </div>
      {error && <p className="set-note set-error">{error}</p>}
    </>
  );
}
