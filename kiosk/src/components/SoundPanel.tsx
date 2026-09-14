/** The Settings page's Sound tab body: which sound this kiosk plays on
 *  a good scan and on a not-found one, how loud, and the sound files
 *  uploaded to this kiosk.
 *
 *  Each choice is a native `<select>` — the kiosk cannot import the
 *  portal's `ComboBox` (a `.tsx` across the two-Reacts boundary), and a
 *  short list of tones on a touch screen is exactly what a native picker
 *  is good at. A Play button beside each one previews the current
 *  choice, because a sound is not something a label can describe.
 *
 *  Uploads live in IndexedDB `sounds` on this kiosk only: nothing is
 *  sent anywhere, and "Clear local data" leaves them alone. */

import { useEffect, useState, type ChangeEvent } from 'react';

import {
  BUILTIN_SOUNDS, MAX_SOUND_BYTES, addUploadedSound, listUploadedSounds, playSoundChoice,
  removeUploadedSound, useSoundSettings, type BuiltinSoundId, type SoundChoice,
  type UploadedSound,
} from '../lib/sound';

/** `none` / `builtin:chime` / `upload:{uuid}` — one `<option>` value per
 *  choice, parsed straight back into the stored shape. */
function choiceValue(choice: SoundChoice): string {
  return choice.kind === 'none' ? 'none' : `${choice.kind}:${choice.id}`;
}

function parseChoice(value: string): SoundChoice {
  const sep = value.indexOf(':');
  if (sep === -1) return { kind: 'none' };
  const kind = value.slice(0, sep);
  const id = value.slice(sep + 1);
  if (kind === 'builtin') return { kind: 'builtin', id: id as BuiltinSoundId };
  if (kind === 'upload' && id) return { kind: 'upload', id };
  return { kind: 'none' };
}

function uploadError(err: unknown): string {
  const code = err instanceof Error ? err.message : '';
  if (code === 'too_large') return 'That file is too large (2 MB max).';
  if (code === 'not_audio') return "That doesn't look like an audio file.";
  return "Couldn't save that sound to this kiosk.";
}

function sizeKb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function SoundPanel() {
  const [settings, setSettings] = useSoundSettings();
  const [uploads, setUploads] = useState<UploadedSound[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    listUploadedSounds().then(setUploads).catch(
      () => setError("Couldn't read this kiosk's uploaded sounds."));
  };

  useEffect(refresh, []);

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear the input either way, so picking the same file again after a
    // rejection still fires a change event.
    e.target.value = '';
    if (!file) return;
    setError(null);
    addUploadedSound(file).then(refresh, (err) => setError(uploadError(err)));
  };

  const onRemove = (id: string) => {
    setError(null);
    removeUploadedSound(id).then(refresh, () => setError("Couldn't remove that sound."));
  };

  const choiceRow = (which: 'good' | 'not_found', label: string, hint: string) => {
    const choice = settings[which];
    return (
      <div className="settings-row">
        <div>
          <span className="settings-row-label">{label}</span>
          <p className="settings-row-hint">{hint}</p>
        </div>
        <div className="sound-choice">
          <select
            aria-label={label}
            value={choiceValue(choice)}
            onChange={(e) => {
              const next = parseChoice(e.target.value);
              setSettings(which === 'good' ? { good: next } : { not_found: next });
            }}
          >
            <option value="none">None</option>
            {BUILTIN_SOUNDS.map((s) => (
              <option key={s.id} value={`builtin:${s.id}`}>{s.label}</option>
            ))}
            {uploads.length > 0 && (
              <optgroup label="Uploaded">
                {uploads.map((u) => (
                  <option key={u.id} value={`upload:${u.id}`}>{u.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          <button type="button" className="mini-btn" onClick={() => playSoundChoice(choice)}>
            Play
          </button>
        </div>
      </div>
    );
  };

  const volume = Math.round(settings.volume * 100);

  return (
    <>
      {choiceRow(
        'good', 'Good scan sound',
        "Played when a scan matches this kiosk's local move data. Stored on this kiosk only.",
      )}
      {choiceRow(
        'not_found', 'Not-found scan sound',
        'Played when a scan matches nothing. Stored on this kiosk only.',
      )}
      <div className="settings-row">
        <div>
          <span className="settings-row-label">Volume</span>
          <p className="settings-row-hint">How loud this kiosk plays its scan sounds.</p>
        </div>
        <label className="sound-volume">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={volume}
            aria-label="Volume"
            onChange={(e) => setSettings({ volume: Number(e.target.value) / 100 })}
          />
          <span className="sound-volume-value mono">{`${volume}%`}</span>
        </label>
      </div>
      <div className="settings-row">
        <div>
          <span className="settings-row-label">Uploaded sounds</span>
          <p className="settings-row-hint">
            MP3, WAV, or OGG up to {Math.round(MAX_SOUND_BYTES / 1024 / 1024)} MB.
            Stored on this kiosk only.
          </p>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <input
          type="file"
          accept="audio/*"
          aria-label="Upload sound"
          onChange={onPick}
        />
      </div>
      {uploads.length > 0 && (
        <div className="sound-uploads">
          {uploads.map((u) => (
            <div key={u.id} className="sound-upload-row">
              <span className="name" title={u.name}>{u.name}</span>
              <span className="size">{sizeKb(u.size)}</span>
              <button
                type="button" className="mini-btn"
                onClick={() => playSoundChoice({ kind: 'upload', id: u.id })}
              >
                Play
              </button>
              <button type="button" className="mini-btn" onClick={() => onRemove(u.id)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
