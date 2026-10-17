/**
 * The "Asset Not Part Of Move" takeover: on a laptop set up as an RFID
 * Station, the whole screen flashes red over every shell page, a siren
 * sounds, and a table names the off-move assets the reader just saw.
 *
 * The open alarm lives on the edge (GET /edge/rfid/alarm), polled every
 * second so a read reaches the screen within about two. Dismiss (a tap on
 * the button, or the space bar) clears only up to the `latest_id` this
 * screen showed: an asset raised after the last poll has a higher id and
 * stays open, so the next poll brings the takeover straight back. Timed
 * mode's expiry is the edge's `expires_at`, so every open page agrees on
 * it; the screen only hides itself at that moment and never sends a
 * dismiss for it.
 *
 * Nothing here throws at the page: every alarm route needs an edge
 * session, so a 401 (or any failure) just keeps the last state, and the
 * siren is silence when the browser won't play — with a "Tap to enable
 * sound" notice when it is the autoplay policy holding it back.
 *
 * `preview` is the Sound tab's Test alarm: the same takeover with the rows
 * and timing it is given, no polling, and no dismiss sent to the edge.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import {
  dismissOffMoveAlarm, getOffMoveAlarm,
  type AlarmMode, type OffMoveAlarmRow, type OffMoveAlarmState,
} from '../lib/api';
import { useKioskSetup } from '../lib/kioskSetup';
import { readSoundSettings, soundBlocked, startSiren } from '../lib/sound';

/** How often the edge is asked for open alarms. */
export const ALARM_POLL_MS = 1000;
/** How often the timed countdown repaints. */
const COUNTDOWN_TICK_MS = 250;

/** A local Test alarm: the rows to show and the timing to show them with
 *  (the Sound tab passes the station's current settings). `onClose` runs
 *  once, on a dismiss or when a timed preview runs out. */
export interface AlarmPreview {
  rows: OffMoveAlarmRow[];
  mode: AlarmMode;
  timed_seconds: number;
  onClose: () => void;
}

export interface OffMoveAlarmProps {
  preview?: AlarmPreview;
}

const DASH = '—';

function cell(value: string | null): string {
  const text = value?.trim();
  return text ? text : DASH;
}

export default function OffMoveAlarm({ preview }: OffMoveAlarmProps) {
  const [setup] = useKioskSetup();
  const titleId = useId();
  const subId = useId();
  const isPreview = preview !== undefined;

  const [edge, setEdge] = useState<OffMoveAlarmState | null>(null);
  /** The highest alarm id this screen dismissed: rows at or below it stay
   *  hidden even if a poll already in flight still carries them. */
  const [dismissedUpTo, setDismissedUpTo] = useState(0);
  const [previewClosed, setPreviewClosed] = useState(false);
  const [previewExpiresAt] = useState<number | null>(() => (
    preview?.mode === 'timed' ? Date.now() + preview.timed_seconds * 1000 : null
  ));
  const [now, setNow] = useState(() => Date.now());
  const [blocked, setBlocked] = useState(false);

  // ── Poll the edge (never in a preview) ────────────────────────────
  useEffect(() => {
    if (isPreview) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getOffMoveAlarm();
        if (!cancelled) {
          setEdge(next);
          setNow(Date.now());
        }
      } catch {
        /* signed out, offline, or not a station: keep the last state */
      }
      if (!cancelled) timer = setTimeout(() => { void poll(); }, ALARM_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [isPreview]);

  const rows: OffMoveAlarmRow[] = isPreview
    ? (previewClosed ? [] : preview.rows)
    : (edge?.alarms ?? []).filter((a) => a.id > dismissedUpTo);
  const latestId = rows.reduce<number | null>((max, a) => (max === null || a.id > max ? a.id : max), null);
  const timed = isPreview ? preview.mode === 'timed' : edge?.mode === 'timed';
  let expiresAt: number | null = null;
  if (isPreview) expiresAt = previewExpiresAt;
  else if (timed && edge?.expires_at) {
    const parsed = Date.parse(edge.expires_at);
    expiresAt = Number.isFinite(parsed) ? parsed : null;
  }
  // Strictly after, as on the edge: at exactly expires_at it is still up.
  const expired = expiresAt !== null && now > expiresAt;
  const open = rows.length > 0 && !expired;
  const secondsLeft = expiresAt !== null ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : null;

  // ── Countdown clock (timed mode only) ─────────────────────────────
  useEffect(() => {
    if (!open || expiresAt === null) return undefined;
    const id = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, [open, expiresAt]);

  // A timed preview that runs out closes like a dismiss.
  const onClose = preview?.onClose;
  useEffect(() => {
    if (!isPreview || previewClosed || !expired) return;
    setPreviewClosed(true);
    onClose?.();
  }, [isPreview, previewClosed, expired, onClose]);

  // ── Siren: one per opening; a re-alarm while open keeps it going ──
  const stopSiren = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    stopSiren.current = startSiren(readSoundSettings().volume);
    setBlocked(soundBlocked());
    const id = setInterval(() => setBlocked(soundBlocked()), ALARM_POLL_MS);
    return () => {
      clearInterval(id);
      stopSiren.current?.();
      stopSiren.current = null;
    };
  }, [open]);

  /** The notice's tap is a user gesture: restarting the siren inside it
   *  resumes the suspended context. It is not a dismiss. */
  const enableSound = () => {
    stopSiren.current?.();
    stopSiren.current = startSiren(readSoundSettings().volume);
    setBlocked(soundBlocked());
  };

  const dismiss = useCallback(() => {
    if (isPreview) {
      if (previewClosed) return;
      setPreviewClosed(true);
      onClose?.();
      return;
    }
    if (latestId === null) return;
    setDismissedUpTo((prev) => Math.max(prev, latestId));
    void dismissOffMoveAlarm(latestId).catch(() => undefined);
  }, [isPreview, previewClosed, onClose, latestId]);

  // ── Space dismisses; a held key's repeats only stop the scroll ────
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      dismissRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (open) buttonRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const moveName = setup?.initiativeName?.trim();
  const count = rows.length;

  return (
    <div className="offmove-alarm" role="alertdialog" aria-modal="true"
         aria-labelledby={titleId} aria-describedby={subId}>
      <h1 id={titleId} className="offmove-alarm-title">
        <span aria-hidden="true">⚠ </span>Asset Not Part Of Move
      </h1>
      <p id={subId} className="offmove-alarm-sub">
        {count} {count === 1 ? 'asset' : 'assets'} not part of{' '}
        {moveName ? <b>{moveName}</b> : 'this move'}
      </p>
      <div className="offmove-alarm-table-wrap">
        <table className="offmove-alarm-table">
          <thead>
            <tr><th>Make / Model</th><th>Name</th><th>Serial</th><th>RFID</th></tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>{cell(a.make_model)}</td>
                <td>{cell(a.name)}</td>
                <td className="mono">{cell(a.serial)}</td>
                <td className="mono">{cell(a.rfid)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="offmove-alarm-foot">
        {blocked ? (
          <button type="button" className="offmove-alarm-sound" onClick={enableSound}>
            Tap to enable sound
          </button>
        ) : (
          <span>Alarm sounding</span>
        )}
        <button ref={buttonRef} type="button" className="offmove-alarm-dismiss" onClick={dismiss}>
          {secondsLeft !== null ? (
            <>Dismiss ({secondsLeft}s)<kbd aria-hidden="true">Space</kbd></>
          ) : (
            <>Tap or press <kbd>Space</kbd> to dismiss</>
          )}
        </button>
      </div>
    </div>
  );
}
