/**
 * Timeclock — the kiosk punch clock.
 *
 * Two states, and nothing else. In **entry** the screen is one
 * always-focused box (the Scanning page's, because a badge reader is a
 * keyboard and focus is the whole interaction): a badge or an id selects
 * its owner the moment it lands, and anything else filters the kiosk's
 * synced people list as it is typed — first name then last, last then
 * first, the preferred name, whatever the person at the screen reaches
 * for (`peopleMatch.ts`). In **selected** the screen is that worker's
 * card — avatar, name, and what the portal says about them right now —
 * with exactly one action on it: Clock in when they are off the clock,
 * Clock out when they are on it.
 *
 * Every punch is a call to the portal, against the move and site from
 * Kiosk Setup, and the answer is what the screen believes: there is no
 * local clock state and no offline queue here (unlike scanning, whose
 * outbox exists because a dock loses signal mid-shift). A punch that
 * didn't reach the API didn't happen, and the screen says so rather than
 * promising to send it later. The portal's `time_entries` rows are the
 * only record of a punch; the kiosk keeps no history of its own.
 *
 * A kiosk is unattended by nature, so the card never sits: twenty idle
 * seconds return it to the entry state, and so does every punch.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { displayRfid } from '@portal/lib/format';

import {
  ApiError, fetchTimeclockStatus, postClockIn, postClockOut,
  type KioskPersonRow, type KioskTimeclockStatus,
} from '../lib/api';
import { hslCss, useAppearance } from '../lib/appearance';
import { flash } from '../lib/flash';
import { getIdentity } from '../lib/identity';
import { useKioskSetup } from '../lib/kioskSetup';
import { getAll } from '../lib/localDb';
import {
  buildPeopleIndex, isAmbiguousPrefix, matchPersonExact, searchPeople, type PeopleIndex,
} from '../lib/peopleMatch';
import { playScanSound } from '../lib/sound';
import { useSyncStatus } from '../lib/sync';

type Phase = 'loading' | 'ready' | 'error';

/** The same rule the Scanning page uses: focus is only reclaimed from
 *  things nobody deliberately moved it to. */
const KEEPS_FOCUS = new Set(['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'A']);

const MAX_RESULTS = 8;
const IDLE_MS = 20_000;      // a card never outlives the person at it
const TICK_MS = 30_000;      // the elapsed counter's resolution
const TOAST_MS = 5_000;
const ERROR_MS = 3_000;

/** "3h 12m", or "45m" under the hour. Minutes, because that is what the
 *  API counts in and what a timesheet is read in. */
function formatMinutes(total: number): string {
  const minutes = Math.max(0, Math.round(total));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function minutesSince(iso: string, now: number): number {
  return Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0] ?? '';
  const last = words.length > 1 ? words[words.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase();
}

/** What a failed punch says out loud. The portal's own code is kept in
 *  the fallback so an unexpected answer is still reportable. */
function punchErrorText(err: unknown): string {
  const code = err instanceof ApiError ? err.code : 'unknown_error';
  const status = err instanceof ApiError ? err.status : 0;
  if (code === 'already_clocked_in') return 'They are already clocked in. Refreshing…';
  if (code === 'not_clocked_in') return 'They are not clocked in. Refreshing…';
  if (code === 'read_only_mode' || status === 423) {
    return 'The portal is in read-only mode. Try again shortly.';
  }
  if (code === 'network') return "Can't reach the portal. The punch was not recorded.";
  return `Couldn't record the punch (${code}).`;
}

export default function Timeclock() {
  const [setup] = useKioskSetup();
  const { phase: syncPhase } = useSyncStatus();
  const [appearance] = useAppearance();

  const [index, setIndex] = useState<PeopleIndex<KioskPersonRow> | null>(null);
  const [loadStatus, setLoadStatus] = useState<Phase>('loading');
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState<KioskPersonRow | null>(null);
  const [status, setStatus] = useState<KioskTimeclockStatus | null>(null);
  const [statusPhase, setStatusPhase] = useState<Phase>('loading');
  const [punching, setPunching] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [idleAt, setIdleAt] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const loadId = useRef(0);
  const statusId = useRef(0);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstLoad = useRef(true);

  // The people list is read once and indexed once — a badge must not
  // wait on IndexedDB. Re-read when a sync finishes (the new name parts
  // arrive with it) or when the stores were just cleared.
  useEffect(() => {
    const load = () => {
      const myLoad = ++loadId.current;
      getAll<KioskPersonRow>('people')
        .then((people) => {
          if (myLoad !== loadId.current) return;
          setIndex(buildPeopleIndex(people));
          setLoadStatus('ready');
        })
        .catch(() => {
          if (myLoad !== loadId.current) return;
          setLoadStatus('error');
        });
    };
    if (firstLoad.current) {
      firstLoad.current = false;
      load();
      return;
    }
    if (syncPhase === 'done' || syncPhase === 'idle') load();
  }, [syncPhase]);

  useEffect(() => () => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const empty = loadStatus === 'ready' && (index?.size ?? 0) === 0;
  const disabled = loadStatus !== 'ready' || empty;

  const focusInput = () => {
    const el = inputRef.current;
    if (el && !el.disabled) el.focus();
  };

  // Entry state only: while a card is up, the buttons own the screen.
  useEffect(() => {
    if (!disabled && !selected) focusInput();
  }, [disabled, selected]);

  useEffect(() => {
    if (disabled || selected) return undefined;
    const reclaim = () => {
      const el = inputRef.current;
      if (!el || el.disabled || document.activeElement === el) return;
      const active = document.activeElement;
      if (active && active !== document.body && KEEPS_FOCUS.has(active.tagName)) return;
      el.focus();
    };
    const onFocusOut = () => { window.setTimeout(reclaim, 0); };
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('visibilitychange', reclaim);
    return () => {
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('visibilitychange', reclaim);
    };
  }, [disabled, selected]);

  const showError = (text: string, ms?: number) => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(text);
    if (ms) errorTimer.current = setTimeout(() => setError(null), ms);
  };

  const showToast = (text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  };

  const toEntry = () => {
    statusId.current += 1;              // a status still in flight loses the screen
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setSelected(null);
    setStatus(null);
    setStatusPhase('loading');
    setPunching(false);
    setValue('');
    setError(null);                     // a failed punch's copy never greets the next worker
  };

  const loadPersonStatus = (personId: string) => {
    const mine = ++statusId.current;
    setStatusPhase('loading');
    fetchTimeclockStatus(personId).then(
      (next) => {
        if (mine !== statusId.current) return;
        setStatus(next);
        setStatusPhase('ready');
      },
      (err: unknown) => {
        if (mine !== statusId.current) return;
        setStatusPhase('error');
        const code = err instanceof ApiError ? err.code : 'unknown_error';
        showError(code === 'network'
          ? "Can't reach the portal. Try again in a moment."
          : `Couldn't read their status (${code}).`);
      },
    );
  };

  const select = (person: KioskPersonRow) => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(null);
    setValue('');
    setAvatarFailed(false);
    setSelected(person);
    setStatus(null);
    setIdleAt(Date.now());
    loadPersonStatus(person.id);
  };

  const results = useMemo(
    () => (index && !selected && value.trim() ? searchPeople(index, value, MAX_RESULTS) : []),
    [index, selected, value],
  );

  // A badge scan is fast typing that happens to end with Enter, so the
  // exact check runs on every keystroke: the tag selects its owner the
  // moment it is complete, without waiting for the Enter to arrive.
  // Except when the value in hand is also a strict prefix of a longer
  // tag in the roster ("1003" vs "100348") — then it is too soon to
  // tell which worker is meant, so the auto-select waits for Enter (or
  // the rest of the scan) to settle it.
  const onChange = (next: string) => {
    if (index && isAmbiguousPrefix(index, next)) {
      setValue(next);
      return;
    }
    const hit = index ? matchPersonExact(index, next) : null;
    if (hit) {
      select(hit);
      return;
    }
    setValue(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter is handled on the key rather than left to a form's implicit
    // submission, which Chrome does not perform for a single-input,
    // button-less form (found live on the Scanning page).
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const raw = value.trim();
    if (!raw || !index) return;
    const exact = matchPersonExact(index, raw);
    if (exact) {
      select(exact);
      return;
    }
    const rows = searchPeople(index, raw, MAX_RESULTS);
    if (rows.length === 1) {
      select(rows[0]);
      return;
    }
    if (rows.length > 1) return;        // several: the list stays, they tap one
    flash(hslCss(appearance.not_found_scan), appearance.flash_ms);
    playScanSound('not_found');
    setValue('');
    showError(`No worker found for "${raw}".`, ERROR_MS);
  };

  const punch = () => {
    if (!selected || !status || punching) return;
    const person = selected;
    const clockingOut = status.clocked_in;
    setPunching(true);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(null);
    const request = clockingOut
      ? postClockOut({ serial: getIdentity().serial, person_id: person.id })
      : postClockIn({
        serial: getIdentity().serial,
        person_id: person.id,
        site_id: setup?.siteId,
        initiative_id: setup?.initiativeId,
      });
    request.then(
      (next) => {
        flash(hslCss(appearance.good_scan), appearance.flash_ms);
        playScanSound('good');
        const name = next.person.display_name;
        const minutes = next.last_entry?.minutes ?? null;
        showToast(clockingOut
          ? `Clocked out — ${name}${minutes === null ? '' : ` · ${formatMinutes(minutes)}`}`
          : `Clocked in — ${name}`);
        toEntry();
      },
      (err: unknown) => {
        flash(hslCss(appearance.not_found_scan), appearance.flash_ms);
        playScanSound('not_found');
        setPunching(false);
        showError(punchErrorText(err), ERROR_MS);
        setIdleAt(Date.now());
        // Those two codes are the portal knowing this worker's state
        // better than the screen does — re-read it and let them tap the
        // right button, rather than making them find the worker again.
        const code = err instanceof ApiError ? err.code : '';
        if (code === 'already_clocked_in' || code === 'not_clocked_in') {
          loadPersonStatus(person.id);
        }
      },
    );
  };

  // The elapsed counter, and the idle timer that hands an abandoned card
  // back to the next person in line.
  const openEntry = status?.clocked_in ? status.entry : null;
  useEffect(() => {
    if (!openEntry) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(id);
  }, [openEntry]);

  useEffect(() => {
    if (!selected) return undefined;
    const id = setTimeout(toEntry, IDLE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- idleAt is the reset signal
  }, [selected, idleAt, punching, statusPhase]);

  const bumpIdle = () => { if (selected) setIdleAt(Date.now()); };

  const subtitle = setup ? `${setup.initiativeName} · ${setup.siteName}` : '';
  const cardName = status?.person.display_name ?? selected?.display_name ?? '';
  const avatarUrl = status?.person.avatar_url ?? null;
  const actionLabel = punching
    ? 'Working…'
    : (status?.clocked_in ? 'Clock out' : 'Clock in');

  return (
    <div className="portal-page" onPointerDown={bumpIdle} onKeyDownCapture={bumpIdle}>
      <div className="eyebrow">Kiosk · Timeclock</div>
      <h1 className="page-title">Timeclock</h1>
      {setup
        ? <p className="page-hint">{subtitle}</p>
        : <p className="page-hint">Finish Kiosk Setup first.</p>}

      {loadStatus === 'error' && (
        <p className="form-error" role="alert">Couldn&apos;t read this kiosk&apos;s local data.</p>
      )}
      {empty && (
        <p className="page-hint">No people on this kiosk. Sync from Kiosk Setup.</p>
      )}
      {toast && <p className="tc-toast" role="status">{toast}</p>}

      {selected ? (
        <>
          <div className="tc-card">
            {avatarUrl && !avatarFailed ? (
              <img
                className="tc-avatar" src={avatarUrl} alt=""
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              <div className="tc-avatar-fallback" aria-hidden="true">{initialsOf(cardName)}</div>
            )}
            <div className="tc-card-body">
              <div className="tc-name">{cardName}</div>
              {statusPhase === 'loading' && <p className="tc-status">Checking the portal…</p>}
              {statusPhase === 'error' && <p className="tc-status is-out">Status unavailable</p>}
              {statusPhase === 'ready' && status && (status.clocked_in && status.entry ? (
                <>
                  <p className="tc-status is-in">
                    Clocked in for <b>{formatMinutes(minutesSince(status.entry.started_at, Date.now()))}</b>
                  </p>
                  <p className="tc-sub">
                    {[`since ${clockTime(status.entry.started_at)}`,
                      status.entry.initiative_name, status.entry.site_name]
                      .filter(Boolean).join(' · ')}
                  </p>
                </>
              ) : (
                <>
                  <p className="tc-status is-out">Not clocked in</p>
                  {status.last_entry && (
                    <p className="tc-sub">Last clock-out {clockTime(status.last_entry.ended_at)}</p>
                  )}
                </>
              ))}
            </div>
          </div>

          <div className="tc-actions">
            <button
              type="button"
              className="btn-solid tc-action"
              disabled={statusPhase !== 'ready' || punching}
              onClick={punch}
            >
              {actionLabel}
            </button>
            <button type="button" className="mini-btn" onClick={toEntry}>Cancel</button>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </>
      ) : (
        <>
          <input
            id="timeclock-input"
            ref={inputRef}
            className="scan-input"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the point of the screen
            autoFocus
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            placeholder="Scan a badge or type a name"
            aria-label="Badge, ID, or name"
            disabled={disabled}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {error && <p className="form-error" role="alert">{error}</p>}
          {results.length > 0 && (
            <div className="tc-results">
              {results.map((person) => (
                <button
                  type="button" key={person.id} className="tc-result"
                  onClick={() => select(person)}
                >
                  <span className="tc-result-name">{person.display_name}</span>
                  {person.is_worker && <span className="tc-result-chip">worker</span>}
                  {person.has_account && <span className="tc-result-chip">account</span>}
                  {person.rfid_tag && (
                    <span className="tc-result-tag">{displayRfid(person.rfid_tag)}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </>
      )}

    </div>
  );
}
