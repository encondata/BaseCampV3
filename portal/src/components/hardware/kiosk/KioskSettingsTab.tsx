/** Settings tab: one card per section that applies to this kiosk, grouped
 *  like the kiosk's own Settings page. Every save PUTs the whole document
 *  with only that section replaced; Reset to defaults confirms first. */

import { useState } from 'react';

import {
  putDeviceConfig, resetDeviceConfig,
  type DeviceConfigHistoryItem, type DeviceDetail, type KioskSoundItem, type StatusValue,
} from '../../../lib/api';
import {
  SECTION_TITLES, applicableSections, configFor, platformCanSync, sectionSource, withSection,
  type SectionKey,
} from '../../../lib/kioskConfig';
import AlarmCard from './AlarmCard';
import AppearanceCard from './AppearanceCard';
import CheckpointsCard from './CheckpointsCard';
import DeveloperCard from './DeveloperCard';
import PlatformSectionCard from './PlatformSectionCard';
import { errorFromApi } from './SectionEditModal';
import SoundCard from './SoundCard';

function ResetConfirm({ kioskName, onConfirm, onClose }: {
  kioskName: string; onConfirm: () => Promise<void>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
    } catch (err) {
      setError(errorFromApi(err).message);
      setBusy(false);
    }
  };
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card kd-confirm-card" role="dialog" aria-label="Reset to defaults">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Kiosk settings · {kioskName}</div>
            <h3>Reset to defaults</h3>
            <p className="page-hint">
              Appearance, sound, checkpoints, developer mode and the off-move alarm go back to their
              defaults. The kiosk picks this up at its next check-in.
            </p>
          </div>
        </div>
        {error && <div className="modal-body"><p className="pf-error" role="alert">{error}</p></div>}
        <div className="modal-foot">
          <button type="button" className="btn-solid" disabled={busy} onClick={() => void go()}>
            {busy ? 'Resetting…' : 'Reset settings'}
          </button>
          <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export default function KioskSettingsTab({
  detail, history, sounds, statuses, canEdit, onSaved, onSoundsChanged,
}: {
  detail: DeviceDetail;
  /** null while it loads: the source lines wait for it. */
  history: DeviceConfigHistoryItem[] | null;
  sounds: KioskSoundItem[];
  statuses: StatusValue[] | null;
  /** Rank 80+ with scanning_hardware change. */
  canEdit: boolean;
  onSaved: (next: DeviceDetail) => void;
  onSoundsChanged: () => void;
}) {
  const [resetting, setResetting] = useState(false);
  const config = configFor(detail.config);
  const syncs = platformCanSync(detail);
  const editable = canEdit && syncs;
  const sections = applicableSections(detail);

  const onSave = editable
    ? async (section: string, value: unknown) => {
      // Start from what's stored (or the defaults), replace one section.
      const doc = withSection(detail.config ?? configFor(null), section, value);
      onSaved(await putDeviceConfig(detail.id, doc));
    }
    : undefined;

  const source = (section: SectionKey): string | null => {
    if (detail.config === null) return 'Defaults · waiting for first report';
    return history === null ? null : sectionSource(section, history);
  };

  const common = { config, kioskName: detail.name, onSave };

  return (
    <section aria-label="Settings">
      <div className="kd-toolbar">
        <p className="page-hint">
          {!syncs
            ? "Settings not reported by this app version yet. Editing opens once this kiosk's app reports its settings."
            : detail.config === null
              ? "This kiosk hasn't reported its settings yet. These are the defaults; an edit here reaches the kiosk at its next check-in."
              : 'Each change reaches the kiosk at its next check-in.'}
        </p>
        {editable && (
          <button type="button" className="mini-btn danger" onClick={() => setResetting(true)}>
            Reset to defaults
          </button>
        )}
      </div>

      <div className="kd-cards">
        {sections.map((key) => {
          switch (key) {
            case 'appearance': return <AppearanceCard key={key} {...common} source={source(key)} />;
            case 'sound':
              return (
                <SoundCard key={key} {...common} source={source(key)} sounds={sounds}
                           showAlarm={sections.includes('alarm')} canUpload={canEdit}
                           onSoundsChanged={onSoundsChanged} />
              );
            case 'checkpoints':
              return <CheckpointsCard key={key} {...common} source={source(key)} statuses={statuses} />;
            case 'developer': return <DeveloperCard key={key} {...common} source={source(key)} />;
            case 'alarm': return <AlarmCard key={key} {...common} source={source(key)} sounds={sounds} />;
            default:
              return <PlatformSectionCard key={key} title={SECTION_TITLES[key]} value={config[key]} />;
          }
        })}
      </div>

      {resetting && (
        <ResetConfirm kioskName={detail.name} onClose={() => setResetting(false)}
          onConfirm={async () => { onSaved(await resetDeviceConfig(detail.id)); setResetting(false); }} />
      )}
    </section>
  );
}
