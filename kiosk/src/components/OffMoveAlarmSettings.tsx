/** The Sound tab's "Off-move alarm" section, shown only on a signed-in
 *  laptop set up as an RFID Station (the same gate KioskShell uses for the
 *  takeover itself).
 *
 *  The settings live on the edge (GET/PUT /edge/rfid/alarm/settings), so
 *  every screen on this laptop agrees. Switching the mode saves at once
 *  with the current seconds; the seconds save on blur or Enter when they
 *  are a whole number from 3 to 600. A failed save keeps the last saved
 *  value and says so. The controls stay disabled until the settings load
 *  (a failed read leaves them so, with its error), and only the newest
 *  save's result is applied.
 *
 *  Test alarm opens the real takeover in preview mode with one sample row:
 *  it sounds the siren but never reads or writes the edge's alarms. */

import { useEffect, useRef, useState } from 'react';

import { useKioskAuth } from '../auth/KioskAuthContext';
import {
  getAlarmSettings, saveAlarmSettings, type AlarmMode, type AlarmSettings, type OffMoveAlarmRow,
} from '../lib/api';
import { useKioskSetup } from '../lib/kioskSetup';
import { isLaptop } from '../lib/platform';
import OffMoveAlarm from './OffMoveAlarm';

const MIN_SECONDS = 3;
const MAX_SECONDS = 600;
const DEFAULTS: AlarmSettings = { mode: 'until_dismissed', timed_seconds: 10 };

const MODES: { id: AlarmMode; label: string }[] = [
  { id: 'until_dismissed', label: 'Until dismissed' },
  { id: 'timed', label: 'Timed' },
];

const SAMPLE_ROW: OffMoveAlarmRow = {
  id: 0,
  make_model: 'Dell PowerEdge R740',
  name: 'sample-server',
  serial: 'SAMPLE123',
  rfid: '100000',
  raised_at: '1970-01-01T00:00:00+00:00',
};

const SAVE_ERROR = "Couldn't save the alarm settings. The last saved value is still in use.";

/** A whole number of seconds in range, or null. */
function parseSeconds(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= MIN_SECONDS && n <= MAX_SECONDS ? n : null;
}

export default function OffMoveAlarmSettings() {
  const { status } = useKioskAuth();
  const [setup] = useKioskSetup();
  if (status !== 'authed' || !isLaptop() || setup?.stationType !== 'rfid') return null;
  return <AlarmSettingsSection />;
}

function AlarmSettingsSection() {
  const [saved, setSaved] = useState<AlarmSettings>(DEFAULTS);
  const [secondsText, setSecondsText] = useState(String(DEFAULTS.timed_seconds));
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  /** False until the edge's settings arrive: before that (or after a failed
   *  read) the controls show defaults, and a save would overwrite the real
   *  settings with them. */
  const [loaded, setLoaded] = useState(false);
  /** Bumped by every save; a result for an older save is ignored. */
  const saveSeq = useRef(0);

  useEffect(() => {
    let live = true;
    getAlarmSettings().then(
      (s) => {
        if (!live) return;
        setSaved(s);
        setSecondsText(String(s.timed_seconds));
        setLoaded(true);
      },
      () => { if (live) setError("Couldn't read the alarm settings from this laptop."); },
    );
    return () => { live = false; };
  }, []);

  const save = (next: AlarmSettings) => {
    if (!loaded) return;
    setError(null);
    const previous = saved;
    const seq = ++saveSeq.current;
    setSaved(next);
    saveAlarmSettings(next).then(
      (s) => { if (seq === saveSeq.current) setSaved(s); },
      () => {
        if (seq !== saveSeq.current) return;
        setSaved(previous);
        setSecondsText(String(previous.timed_seconds));
        setInvalid(false);
        setError(SAVE_ERROR);
      },
    );
  };

  const pickMode = (mode: AlarmMode) => {
    if (mode === saved.mode) return;
    save({ mode, timed_seconds: saved.timed_seconds });
  };

  const commitSeconds = () => {
    const n = parseSeconds(secondsText);
    if (n === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setSecondsText(String(n));
    if (n !== saved.timed_seconds) save({ mode: saved.mode, timed_seconds: n });
  };

  const timed = saved.mode === 'timed';

  return (
    <>
      <div className="settings-row">
        <div>
          <span className="settings-row-label">Off-move alarm</span>
          <p className="settings-row-hint">
            Plays at the volume set above and the laptop&apos;s own volume.
          </p>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="segmented" role="radiogroup" aria-label="Off-move alarm mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={m.id === saved.mode}
              className={m.id === saved.mode ? 'on' : ''}
              disabled={!loaded}
              onClick={() => pickMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-row">
        <div>
          <label htmlFor="alarm-seconds" className="settings-row-label">Timed alarm length</label>
          <p
            id="alarm-seconds-hint"
            className={invalid ? 'settings-row-hint form-error' : 'settings-row-hint'}
          >
            3–600 seconds
          </p>
        </div>
        <span className="alarm-seconds">
          <input
            id="alarm-seconds"
            type="number"
            inputMode="numeric"
            min={MIN_SECONDS}
            max={MAX_SECONDS}
            step={1}
            aria-label="Alarm seconds"
            aria-describedby="alarm-seconds-hint"
            aria-invalid={invalid || undefined}
            disabled={!loaded || !timed}
            value={secondsText}
            onChange={(e) => setSecondsText(e.target.value)}
            onBlur={commitSeconds}
            onKeyDown={(e) => { if (e.key === 'Enter') commitSeconds(); }}
          />
          <span className="alarm-seconds-unit">s</span>
        </span>
      </div>
      <div className="settings-row">
        <div>
          <span className="settings-row-label">Alarm preview</span>
          <p className="settings-row-hint">
            Shows the alarm with a sample asset, using the mode above. Tap or press Space to
            end it. Nothing is recorded.
          </p>
        </div>
        <button type="button" className="mini-btn" onClick={() => setPreviewing(true)}>
          Test alarm
        </button>
      </div>
      {previewing && (
        <OffMoveAlarm
          preview={{
            rows: [SAMPLE_ROW],
            mode: saved.mode,
            timed_seconds: parseSeconds(secondsText) ?? saved.timed_seconds,
            onClose: () => setPreviewing(false),
          }}
        />
      )}
    </>
  );
}
