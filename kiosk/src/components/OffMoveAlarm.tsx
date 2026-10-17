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
 * While open, everything outside the takeover is `inert`, the newest open
 * takeover alone answers the keyboard, and Enter and Space are ignored for
 * the first second (a barcode scan landing as it opens is not a dismiss).
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
import { soundBlocked, soundSettled, startAlarmSound } from '../lib/sound';

/** How often the edge is asked for open alarms. */
export const ALARM_POLL_MS = 1000;
/** How often the timed countdown repaints. */
const COUNTDOWN_TICK_MS = 250;
/** How long after opening Enter and Space are swallowed: a keyboard-wedge
 *  barcode scan landing as the takeover opens must not dismiss it. */
export const KEY_GUARD_MS = 1000;
/** The first "is the sound blocked?" check waits for the siren's resume()
 *  to settle, or this long when the browser leaves it pending. */
const SOUND_CHECK_GRACE_MS = 300;

/* ── Open takeovers: the newest one owns the keyboard ──────────────── */

/** Open takeovers' root elements, oldest first. Only the last one (on top)
 *  answers Space, and everything outside it is inert. */
const openTakeovers: HTMLElement[] = [];
/** The elements this module made inert (never one someone else did). */
const madeInert = new Set<Element>();

/** Marks every element outside the top takeover (each sibling of it and
 *  of its ancestors) inert, so Tab, Enter and Escape can't reach the page
 *  underneath; with none open, undoes exactly what it set. */
function syncInert(): void {
  madeInert.forEach((el) => el.removeAttribute('inert'));
  madeInert.clear();
  const top = openTakeovers[openTakeovers.length - 1];
  if (!top) return;
  for (let node: Element = top; node.parentElement && node !== document.body;
    node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || sibling.hasAttribute('inert')) continue;
      sibling.setAttribute('inert', '');
      madeInert.add(sibling);
    }
  }
}

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
  // The notice is only shown once resume() has had its chance: checked
  // when it settles (or after a short grace, if the browser holds it), then
  // every second — never in the instant before a resume lands.
  const stopSiren = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    const check = () => { if (live) setBlocked(soundBlocked()); };
    stopSiren.current = startAlarmSound();
    setBlocked(false);
    void soundSettled().then(check);
    const grace = setTimeout(check, SOUND_CHECK_GRACE_MS);
    const id = setInterval(check, ALARM_POLL_MS);
    return () => {
      live = false;
      clearTimeout(grace);
      clearInterval(id);
      stopSiren.current?.();
      stopSiren.current = null;
    };
  }, [open]);

  /** The notice's tap is a user gesture: restarting the siren inside it
   *  resumes the suspended context. It is not a dismiss. */
  const enableSound = () => {
    stopSiren.current?.();
    stopSiren.current = startAlarmSound();
    void soundSettled().then(() => setBlocked(soundBlocked()));
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
  // Only the top takeover answers, and it stops the key there, so one press
  // can't close a Test alarm preview and a live alarm together. For the
  // first second after opening, Enter and Space are swallowed outright (a
  // wedge scan's trailing Enter would press the focused Dismiss); taps
  // still work.
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const root = rootRef.current;
    const openedAt = Date.now();
    if (root) {
      openTakeovers.push(root);
      syncInert();
    }
    const onKey = (e: KeyboardEvent) => {
      if (root && openTakeovers[openTakeovers.length - 1] !== root) return;
      const space = e.code === 'Space' || e.key === ' ';
      const enter = e.key === 'Enter';
      if (!space && !enter) return;
      const guarded = Date.now() - openedAt < KEY_GUARD_MS;
      if (enter && !guarded) return;   // left to the focused button
      e.preventDefault();
      e.stopImmediatePropagation();
      if (guarded || e.repeat) return;
      dismissRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (root) {
        const at = openTakeovers.indexOf(root);
        if (at >= 0) openTakeovers.splice(at, 1);
        syncInert();
      }
    };
  }, [open]);

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (open) buttonRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const moveName = setup?.initiativeName?.trim();
  const count = rows.length;

  return (
    <div ref={rootRef} className="offmove-alarm" role="alertdialog" aria-modal="true"
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
