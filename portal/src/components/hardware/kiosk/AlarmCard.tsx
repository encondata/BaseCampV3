/** Settings › Off-move alarm (laptop RFID Stations only): how long the
 *  alarm sounds when a tag from outside the move is read. Its sound is a
 *  slot on the Sound card and is shown here for reference. */

import { useState } from 'react';

import type { KioskSoundItem } from '../../../lib/api';
import {
  ALARM_SECONDS_MAX, ALARM_SECONDS_MIN, sectionOf, soundLabel, type AlarmSection,
} from '../../../lib/kioskConfig';
import { numberOrRaw } from './AppearanceCard';
import SectionEditModal, { FieldError } from './SectionEditModal';
import SettingsCard from './SettingsCard';
import type { SectionProps } from './types';

const MODE_LABELS: Record<string, string> = { until_dismissed: 'Until dismissed', timed: 'Timed' };

function AlarmModal({ value, onReload, kioskName, onSave, onClose }: {
  onReload?: () => Promise<void>;
  value: AlarmSection; kioskName: string;
  onSave: (next: AlarmSection) => Promise<void>; onClose: () => void;
}) {
  const [mode, setMode] = useState(value.mode);
  const [seconds, setSeconds] = useState(String(value.timed_seconds));
  return (
    <SectionEditModal
      title="Edit off-move alarm" kioskName={kioskName}
      description="How long the alarm sounds when the station reads a tag that isn't on its move."
      fields={['alarm.mode', 'alarm.timed_seconds']}
      onClose={onClose} onReload={onReload}
      onSave={() => onSave({ ...value, mode, timed_seconds: numberOrRaw(seconds) as number })}
    >
      {(error) => (
        <div className="pf-form">
          <div className="kd-field full">
            <label>Mode</label>
            <div className="segmented" role="radiogroup" aria-label="Alarm mode">
              {(['until_dismissed', 'timed'] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m}
                        className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                  {MODE_LABELS[m]}
                </button>
              ))}
            </div>
            <FieldError error={error} path="alarm.mode" />
          </div>
          {mode === 'timed' && (
            <div className="kd-field">
              <label htmlFor="kd-alarm-seconds">Alarm length</label>
              <input id="kd-alarm-seconds" aria-label="Alarm length (seconds)" inputMode="numeric"
                     value={seconds} onChange={(e) => setSeconds(e.target.value)} />
              <FieldError error={error} path="alarm.timed_seconds" />
              <p className="set-note" style={{ padding: 0, marginTop: 6 }}>
                {ALARM_SECONDS_MIN}–{ALARM_SECONDS_MAX} seconds.
              </p>
            </div>
          )}
        </div>
      )}
    </SectionEditModal>
  );
}

export default function AlarmCard({
  config, kioskName, source, onSave, onReload, sounds,
}: SectionProps & { sounds: KioskSoundItem[] }) {
  const [editing, setEditing] = useState(false);
  const a = sectionOf(config, 'alarm');
  const sound = sectionOf(config, 'sound').alarm;
  return (
    <SettingsCard title="Off-move alarm" source={source} onEdit={onSave ? () => setEditing(true) : undefined}>
      <dl className="kv">
        <dt>Mode</dt><dd>{MODE_LABELS[a.mode] ?? a.mode}</dd>
        {a.mode === 'timed' && (<><dt>Alarm length</dt><dd className="mono">{a.timed_seconds} s</dd></>)}
        <dt>Sound</dt><dd>{soundLabel(sound, sounds)}</dd>
      </dl>
      {editing && onSave && (
        <AlarmModal value={a} onReload={onReload} kioskName={kioskName} onClose={() => setEditing(false)}
          onSave={async (next) => { await onSave('alarm', next); setEditing(false); }} />
      )}
    </SettingsCard>
  );
}
