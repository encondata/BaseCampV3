/**
 * The guided time clock: Welcome (station only) → Enter Your Name → Is
 * this you? → Clock In / Clock Out → (badge) → You're All Set. The
 * transitions are `flow.ts`'s pure reducer; this component owns every
 * side effect — the people list, the status read, the punch, the flash
 * and sound, the timers — and reports each outcome as an action.
 *
 * Finding a person works like the old Timeclock page: a badge reader is
 * a keyboard, so on Welcome a hidden input and on Enter Your Name the
 * search box always hold focus, and a value that names exactly one
 * person (RFID tag, badge UUID, id — `matchPersonExact`) selects them the
 * moment it is complete, unless it is also the start of a longer tag
 * (`isAmbiguousPrefix`), when Enter settles it.
 *
 * Two guards keep a punch honest:
 *  - one punch per tap: the reducer ignores the punch-starting actions
 *    while `busy`, and a punch is sent only when an action takes the
 *    state into busy, so a double tap can never send two;
 *  - one person per answer: every person gets a fresh session number, and
 *    leaving (idle, Done, Back off the name screen) bumps it, so a status
 *    or punch that answers late is dropped rather than painted over the
 *    next person's screen.
 */

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent, type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiError, type KioskPersonRow } from '../lib/api';
import { hslCss, useAppearance } from '../lib/appearance';
import { flash } from '../lib/flash';
import {
  buildPeopleIndex, isAmbiguousPrefix, matchPersonExact, searchPeople, type PeopleIndex,
} from '../lib/peopleMatch';
import { playScanSound } from '../lib/sound';
import type { TimeclockBackend } from './backend';
import {
  DONE_MS, IDLE_MS, PRINTING_MS, START_STEP, initialState, reducer,
  type FlowAction, type FlowMode, type FlowState,
} from './flow';
import { IconArrowLeft } from './icons';
import OnScreenKeyboard from './OnScreenKeyboard';
import AllSet from './screens/AllSet';
import BadgeQuestion from './screens/BadgeQuestion';
import ChooseAction from './screens/ChooseAction';
import ClockOutSummary from './screens/ClockOutSummary';
import ConfirmPerson from './screens/ConfirmPerson';
import EnterName from './screens/EnterName';
import PrintingBadge from './screens/PrintingBadge';
import VerifyBadge from './screens/VerifyBadge';
import Welcome from './screens/Welcome';
import TcShell from './TcShell';
import { useIdle } from './useIdle';

export interface TimeclockFlowProps {
  mode: FlowMode;
  backend: TimeclockBackend;
  /** Kiosk mode: leave the flow (Done, idle, Back on Enter Your Name). */
  onExit?: () => void;
  /** Station mode: the station key is missing or lapsed — Welcome says so
   *  and takes nobody. */
  paused?: boolean;
}

const MAX_RESULTS = 8;
/** How long "We couldn't find that code." and its kind stay up. */
const MESSAGE_MS = 5_000;

const NOT_FOUND = "We couldn't find that code.";
const NO_NAME_MATCH = 'No one matches that name.';
const LOOKUP_UNREACHABLE = "Can't reach the portal. Try again.";
const LOOKUP_FAILED = 'Something went wrong. Try again.';

/** Focus is only reclaimed from things nobody deliberately moved it to. */
const KEEPS_FOCUS = new Set(['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'A']);

function codeOf(err: unknown): string {
  return err instanceof ApiError ? err.code : 'unknown_error';
}

export default function TimeclockFlow({ mode, backend, onExit, paused = false }: TimeclockFlowProps) {
  const navigate = useNavigate();
  const [appearance] = useAppearance();

  // The reducer's state, mirrored in a ref so a handler can see the state
  // an action produces before React re-renders (the busy transition).
  const [state, setState] = useState<FlowState>(() => initialState(mode));
  const stateRef = useRef(state);
  const apply = useCallback((action: FlowAction): [FlowState, FlowState] => {
    const prev = stateRef.current;
    const next = reducer(prev, action);
    if (next !== prev) {
      stateRef.current = next;
      setState(next);
    }
    return [prev, next];
  }, []);

  const session = useRef(0);
  const [index, setIndex] = useState<PeopleIndex<KioskPersonRow> | null>(null);
  const [peopleFailed, setPeopleFailed] = useState(false);
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { step } = state;
  const atStart = step === START_STEP(mode);
  const typing = step === 'welcome' || step === 'name';

  // The people list, read again each time the flow is back at its start so
  // a station that runs all day picks up new hires. The old index stays in
  // use until the new one arrives.
  useEffect(() => {
    if (!atStart) return undefined;
    let live = true;
    backend.people().then(
      (people) => {
        if (!live) return;
        setIndex(buildPeopleIndex(people));
        setPeopleFailed(false);
      },
      () => { if (live) setPeopleFailed(true); },
    );
    return () => { live = false; };
  }, [backend, atStart]);

  useEffect(() => {
    if (!message) return undefined;
    const id = setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => clearTimeout(id);
  }, [message]);

  const good = useCallback(() => {
    flash(hslCss(appearance.good_scan), appearance.flash_ms);
    playScanSound('good');
  }, [appearance]);
  const bad = useCallback(() => {
    flash(hslCss(appearance.not_found_scan), appearance.flash_ms);
    playScanSound('not_found');
  }, [appearance]);

  /** Leaves the flow: back to Welcome on a station, out to Home on a kiosk. */
  const exit = useCallback(() => {
    session.current += 1;
    setValue('');
    setMessage(null);
    setLooking(false);
    setRefreshing(false);
    if (mode === 'kiosk' && onExit) onExit();
    else apply({ type: 'reset' });
  }, [apply, mode, onExit]);

  const identify = (person: KioskPersonRow) => {
    const mine = ++session.current;
    setValue('');
    setMessage(null);
    setLooking(true);
    backend.status(person.id).then(
      (status) => {
        if (mine !== session.current) return;
        setLooking(false);
        good();
        apply({ type: 'identified', status });
      },
      (err: unknown) => {
        if (mine !== session.current) return;
        setLooking(false);
        bad();
        const code = codeOf(err);
        setMessage(code === 'network' || code === 'edge_offline' ? LOOKUP_UNREACHABLE : LOOKUP_FAILED);
      },
    );
  };

  const notFound = (text: string, clear: boolean) => {
    bad();
    if (clear) setValue('');
    setMessage(text);
  };

  // A badge scan is fast typing that happens to end with Enter, so the
  // exact check runs on every keystroke — except while the value is also
  // a strict prefix of a longer tag ("1003" vs "100348"), when Enter (or
  // the rest of the scan) decides.
  const onValue = (next: string) => {
    if (looking) return;
    if (message) setMessage(null);
    if (index && !isAmbiguousPrefix(index, next)) {
      const hit = matchPersonExact(index, next);
      if (hit) {
        identify(hit);
        return;
      }
    }
    setValue(next);
  };

  const submit = () => {
    const raw = value.trim();
    if (!raw || !index || looking) return;
    const exact = matchPersonExact(index, raw);
    if (exact) {
      identify(exact);
      return;
    }
    if (step === 'name') {
      const rows = searchPeople(index, raw, MAX_RESULTS);
      if (rows.length === 1) identify(rows[0]);
      else if (rows.length === 0) notFound(NO_NAME_MATCH, false);
      return;
    }
    notFound(NOT_FOUND, true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter is handled on the key: Chrome performs no implicit submission
    // for a single-input, button-less form (found live on Scanning).
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submit();
  };

  // ---- punches ----

  const send = (kind: 'in' | 'out') => {
    const status = stateRef.current.status;
    if (!status) return;
    const mine = session.current;
    const personId = status.person.id;
    const call = kind === 'in' ? backend.clockIn(personId) : backend.clockOut(personId);
    call.then(
      (next) => {
        if (mine !== session.current) return;
        good();
        apply({ type: 'punchSucceeded', status: next, punched: kind });
      },
      (err: unknown) => {
        if (mine !== session.current) return;
        bad();
        const code = codeOf(err);
        apply({ type: 'punchFailed', code });
        // Someone punched elsewhere in between: the portal knows better
        // than the screen, so re-read and let them choose again.
        if (code === 'already_clocked_in' || code === 'not_clocked_in') {
          setRefreshing(true);
          backend.status(personId).then(
            (fresh) => {
              if (mine !== session.current) return;
              setRefreshing(false);
              apply({ type: 'statusRefreshed', status: fresh });
            },
            () => { if (mine === session.current) setRefreshing(false); },
          );
        }
      },
    );
  };

  /** Sends a punch only when `action` takes the flow into busy. */
  const punch = (action: FlowAction, kind: 'in' | 'out') => {
    const [prev, next] = apply(action);
    if (!prev.busy && next.busy) send(kind);
  };

  // ---- timers ----

  const idleActive = !atStart && step !== 'done';
  useIdle(idleActive, IDLE_MS, exit);

  useEffect(() => {
    if (step !== 'printing') return undefined;
    const id = setTimeout(() => apply({ type: 'printingDone' }), PRINTING_MS);
    return () => clearTimeout(id);
  }, [step, apply]);

  // The latest exit, so a parent passing a fresh `onExit` each render
  // never restarts the All Set countdown.
  const exitRef = useRef(exit);
  exitRef.current = exit;
  useEffect(() => {
    if (step !== 'done') return undefined;
    const id = setTimeout(() => exitRef.current(), DONE_MS);
    return () => clearTimeout(id);
  }, [step]);

  // ---- focus: the reader's keystrokes must land in the input ----

  const inputOff = looking || (step === 'welcome' && paused);
  useEffect(() => {
    if (typing && !inputOff) inputRef.current?.focus();
  }, [typing, step, inputOff]);

  useEffect(() => {
    if (!typing) return undefined;
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
  }, [typing]);

  // A tap on a button while the input is up must not take focus off it.
  const keepFocus = (e: MouseEvent<HTMLDivElement>) => {
    if (typing && (e.target as Element).closest?.('button')) e.preventDefault();
  };

  // ---- back ----

  const back = () => {
    if (step === 'name') {
      session.current += 1;            // a lookup still in flight loses the screen
      setLooking(false);
      setValue('');
      setMessage(null);
      if (mode === 'kiosk') {
        exit();
        return;
      }
    }
    apply({ type: 'back' });
  };
  const hasBack = step === 'name' || step === 'confirm' || step === 'action' || step === 'clockOut';
  const busy = state.busy || refreshing;

  const results = useMemo(
    () => (index && step === 'name' && value.trim() ? searchPeople(index, value, MAX_RESULTS) : []),
    [index, step, value],
  );

  const shownMessage = message ?? (peopleFailed && !index ? "Can't load the people list. Try again shortly." : null);

  // ---- screens ----

  const status = state.status;
  let screen: ReactNode = null;
  switch (step) {
    case 'welcome':
      screen = (
        <Welcome
          paused={paused}
          message={shownMessage}
          onScan={() => { setMessage(null); inputRef.current?.focus(); }}
          onName={() => { setValue(''); setMessage(null); apply({ type: 'enterName' }); }}
          scanInput={(
            <input
              ref={inputRef}
              className="tcx-scan-input"
              aria-label="Scan your code"
              autoComplete="off"
              spellCheck={false}
              inputMode="none"
              disabled={inputOff}
              value={value}
              onChange={(e) => onValue(e.target.value)}
              onKeyDown={onKeyDown}
            />
          )}
        />
      );
      break;
    case 'name':
      screen = (
        <EnterName
          message={shownMessage}
          results={results}
          noMatches={!!index && value.trim() !== '' && results.length === 0 && !message}
          disabled={looking}
          onPick={identify}
          searchInput={(
            <input
              ref={inputRef}
              className="tcx-search-input"
              aria-label="Your name"
              placeholder="Start typing your name…"
              autoComplete="off"
              spellCheck={false}
              inputMode="none"
              disabled={looking}
              value={value}
              onChange={(e) => onValue(e.target.value)}
              onKeyDown={onKeyDown}
            />
          )}
          keyboard={(
            <OnScreenKeyboard
              value={value}
              disabled={looking}
              onKey={(ch) => onValue(value + ch)}
              onBackspace={() => onValue(value.slice(0, -1))}
              onSearch={submit}
            />
          )}
        />
      );
      break;
    case 'confirm':
      if (status) {
        screen = (
          <ConfirmPerson
            person={status.person}
            onYes={() => apply({ type: 'confirmYes' })}
            onNo={() => { setValue(''); apply({ type: 'confirmNo' }); }}
          />
        );
      }
      break;
    case 'action':
      if (status) {
        screen = (
          <ChooseAction
            status={status}
            busy={busy}
            notice={state.notice}
            error={state.error}
            onIn={() => punch({ type: 'chooseIn' }, 'in')}
            onOut={() => apply({ type: 'chooseOut' })}
            onRetry={() => punch({ type: 'punchStarted' }, 'in')}
          />
        );
      }
      break;
    case 'clockOut':
      if (status) {
        screen = (
          <ClockOutSummary
            status={status}
            busy={busy}
            error={state.error}
            onConfirm={() => punch({ type: 'punchStarted' }, 'out')}
            onRetry={() => punch({ type: 'punchStarted' }, 'out')}
          />
        );
      }
      break;
    case 'badge':
      screen = (
        <BadgeQuestion
          onNew={() => apply({ type: 'badgeNew' })}
          onExisting={() => apply({ type: 'badgeExisting' })}
        />
      );
      break;
    case 'printing':
      screen = <PrintingBadge />;
      break;
    case 'verify':
      screen = <VerifyBadge onContinue={() => apply({ type: 'verifyContinue' })} />;
      break;
    case 'done': {
      const p = status?.person;
      const name = p?.preferred_name?.trim() || p?.first_name?.trim() || p?.display_name.split(' ')[0] || '';
      screen = <AllSet name={name} onDone={exit} />;
      break;
    }
  }

  return (
    <TcShell
      step={step}
      onMouseDown={keepFocus}
      onSettings={mode === 'station' && step === 'welcome' ? () => navigate('/login') : undefined}
      back={hasBack ? (
        <button type="button" className="tcx-back" disabled={busy} onClick={back}>
          <IconArrowLeft className="tcx-btn-icon" /> Back
        </button>
      ) : undefined}
    >
      {screen}
    </TcShell>
  );
}
