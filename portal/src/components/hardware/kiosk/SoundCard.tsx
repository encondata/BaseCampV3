/** Settings › Sound: the scan sounds, the off-move alarm sound (laptop RFID
 *  Stations), the volume, and uploading a sound to the shared library.
 *  Uploaded sounds play here from GET /kiosk-sounds/{id}/file. Built-ins are
 *  synthesized on the kiosk and the portal has no copy of that synth, so
 *  they show by name without Play. */

import { Fragment, useEffect, useRef, useState } from 'react';

import ComboBox, { type ComboOption } from '../../ComboBox';
import {
  ApiError, getKioskSoundBlob, uploadKioskSound, type KioskSoundItem,
} from '../../../lib/api';
import {
  BUILTIN_SOUNDS, sectionOf, soundFromValue, soundLabel, soundValue,
  type SoundRef, type SoundSection,
} from '../../../lib/kioskConfig';
import { naturalCompare } from '../../../lib/naturalSort';
import SectionEditModal, { FieldError } from './SectionEditModal';
import SettingsCard from './SettingsCard';
import type { SectionProps } from './types';

type Slot = 'good' | 'not_found' | 'duplicate' | 'alarm';

const SLOTS: { key: Slot; label: string }[] = [
  { key: 'good', label: 'Good scan sound' },
  { key: 'not_found', label: 'Not-found sound' },
  { key: 'duplicate', label: 'Duplicate sound' },
  { key: 'alarm', label: 'Off-move alarm sound' },
];

function slotOptions(slot: Slot, sounds: KioskSoundItem[]): ComboOption[] {
  const head: ComboOption[] = slot === 'alarm'
    ? [{ value: 'siren', label: 'Siren', sub: 'Built-in' }]
    : [{ value: 'none', label: 'None' }];
  const uploads = [...sounds].sort((a, b) => naturalCompare(a.name, b.name));
  return [
    ...head,
    ...BUILTIN_SOUNDS.map((s) => ({ value: `builtin:${s.id}`, label: s.label, sub: 'Built-in' })),
    ...uploads.map((s) => ({ value: `upload:${s.id}`, label: s.name, sub: 'Uploaded' })),
  ];
}

const UPLOAD_ERRORS: Record<string, string> = {
  not_audio: 'That file is not an audio file.',
  empty_file: 'That file is empty.',
  file_too_large: 'Sounds can be at most 2 MB.',
  forbidden_rank: 'Only super admins can upload sounds.',
};

/** Play an uploaded sound once, at the kiosk's volume. */
function PlayButton({ id, name, volume }: { id: string; name: string; volume: number }) {
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const urlRef = useRef<string | null>(null);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  const play = async () => {
    setState('loading');
    try {
      if (!urlRef.current) urlRef.current = URL.createObjectURL(await getKioskSoundBlob(id));
      const audio = new Audio(urlRef.current);
      audio.volume = Math.min(1, Math.max(0, volume));
      await audio.play();
      setState('idle');
    } catch {
      setState('failed');
    }
  };
  return (
    <button type="button" className="mini-btn" aria-label={`Play ${name}`} disabled={state === 'loading'}
            title={state === 'failed' ? "Couldn't play this sound." : undefined}
            onClick={() => void play()}>
      {state === 'failed' ? 'Retry' : 'Play'}
    </button>
  );
}

function SoundValue({ sref, sounds, volume }: { sref: SoundRef; sounds: KioskSoundItem[]; volume: number }) {
  const label = soundLabel(sref, sounds);
  const playable = sref.kind === 'upload' && sounds.some((s) => s.id === sref.id);
  return (
    <span className="kd-sound">
      <span>{label}</span>
      {sref.kind === 'upload' && playable && <PlayButton id={sref.id} name={label} volume={volume} />}
    </span>
  );
}

function SoundModal({ value, onReload, sounds, showAlarm, kioskName, onSave, onClose }: {
  onReload?: () => Promise<void>;
  value: SoundSection; sounds: KioskSoundItem[]; showAlarm: boolean; kioskName: string;
  onSave: (next: SoundSection) => Promise<void>; onClose: () => void;
}) {
  const [draft, setDraft] = useState<SoundSection>(value);
  const slots = SLOTS.filter((s) => showAlarm || s.key !== 'alarm');
  const pct = Math.round(draft.volume * 100);
  return (
    <SectionEditModal
      title="Edit sound" kioskName={kioskName}
      description="The sound the kiosk plays for each scan result, and how loud."
      fields={['sound.good', 'sound.not_found', 'sound.duplicate', 'sound.alarm', 'sound.volume']}
      onClose={onClose} onReload={onReload}
      onSave={() => onSave(draft)}
    >
      {(error) => (
        <div className="pf-form">
          {slots.map((s) => (
            <div key={s.key} className="kd-field">
              <label>{s.label}</label>
              <ComboBox ariaLabel={s.label} options={slotOptions(s.key, sounds)}
                        value={soundValue(draft[s.key])}
                        onChange={(v) => { if (v) setDraft((d) => ({ ...d, [s.key]: soundFromValue(v) })); }} />
              <FieldError error={error} path={`sound.${s.key}`} />
            </div>
          ))}
          <div className="kd-field full">
            <label>Volume</label>
            <div className="kd-range">
              <input type="range" min={0} max={100} step={1} value={pct} aria-label="Volume"
                     onChange={(e) => setDraft((d) => ({ ...d, volume: Number(e.target.value) / 100 }))} />
              <span className="mono">{pct}%</span>
            </div>
            <FieldError error={error} path="sound.volume" />
          </div>
        </div>
      )}
    </SectionEditModal>
  );
}

export default function SoundCard({
  config, kioskName, source, onSave, onReload, sounds, showAlarm, canUpload, onSoundsChanged,
}: SectionProps & {
  sounds: KioskSoundItem[];
  showAlarm: boolean;
  canUpload: boolean;
  onSoundsChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const s = sectionOf(config, 'sound');
  const slots = SLOTS.filter((x) => showAlarm || x.key !== 'alarm');

  const upload = async (file: File) => {
    setUploading(true);
    setNote('');
    try {
      const out = await uploadKioskSound(file);
      setNote(`Uploaded ${out.name}. Pick it in Edit to use it on this kiosk.`);
      onSoundsChanged();
    } catch (err) {
      setNote(err instanceof ApiError
        ? (UPLOAD_ERRORS[err.code] ?? `Upload failed (${err.code}).`)
        : 'Upload failed. Check the connection and try again.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <SettingsCard
      title="Sound" source={source} onEdit={onSave ? () => setEditing(true) : undefined}
      actions={canUpload && (
        <>
          <input ref={fileRef} type="file" accept="audio/*" hidden aria-label="Sound file"
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          <button type="button" className="mini-btn" disabled={uploading}
                  onClick={() => fileRef.current?.click()}>
            {uploading ? 'Uploading…' : 'Upload sound'}
          </button>
        </>
      )}
    >
      <dl className="kv">
        {slots.map((x) => (
          <Fragment key={x.key}>
            <dt>{x.label}</dt>
            <dd><SoundValue sref={s[x.key]} sounds={sounds} volume={s.volume} /></dd>
          </Fragment>
        ))}
        <dt>Volume</dt><dd className="mono">{Math.round(s.volume * 100)}%</dd>
      </dl>
      {note && <p className="set-note" role="status" style={{ padding: 0, marginTop: 10 }}>{note}</p>}
      {editing && onSave && (
        <SoundModal value={s} onReload={onReload} sounds={sounds} showAlarm={showAlarm} kioskName={kioskName}
          onClose={() => setEditing(false)}
          onSave={async (next) => { await onSave('sound', next); setEditing(false); }} />
      )}
    </SettingsCard>
  );
}
