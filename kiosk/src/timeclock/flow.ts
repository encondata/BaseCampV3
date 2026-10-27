/**
 * The guided time clock flow as a pure reducer. The component owns every
 * side effect (the status read, the punch, the badge print, the timers)
 * and reports what happened as an action; nothing here touches the
 * network, a timer or the clock, so each transition is a plain
 * state-in, state-out test.
 *
 * Two modes share the steps. `station` is the signed-out Time Clock
 * laptop: it starts on `welcome` and Back from `name` returns there.
 * `kiosk` is a signed-in kiosk reaching the flow from its menu: it starts
 * on `name`, and leaving from there is the component's call, so Back from
 * `name` changes nothing here.
 *
 * `learning` is the soft gate before a clock-in: a worker with unsigned
 * learning sees what is outstanding instead of punching straight away. It
 * never refuses the punch: Cancel resets, and an admin override (made by
 * the component, which reports its id) goes on to clock in. Clock-out
 * never passes through it.
 */

import { CLOUD_SIGN_IN_TEXT, type KioskTimeclockStatus } from '../lib/api';

export type FlowMode = 'station' | 'kiosk';

export type Step =
  | 'welcome' | 'name' | 'confirm' | 'action' | 'clockOut'
  | 'learning' | 'badge' | 'printing' | 'verify' | 'done';

export interface FlowState {
  mode: FlowMode;
  step: Step;
  status: KioskTimeclockStatus | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  punched: 'in' | 'out' | null;
  /** The admin override the clock-in from `learning` rides on. */
  learningOverrideId: string | null;
  /** "Email me the link" went out for this person. */
  learningLinkSent: boolean;
}

export type FlowAction =
  | { type: 'enterName' }
  | { type: 'identified'; status: KioskTimeclockStatus }
  | { type: 'confirmYes' }
  | { type: 'confirmNo' }
  | { type: 'chooseIn' }
  | { type: 'chooseOut' }
  | { type: 'learningOverride'; overrideId: string }
  | { type: 'learningCancel' }
  | { type: 'learningLinkSent' }
  | { type: 'punchStarted' }
  | { type: 'punchSucceeded'; status: KioskTimeclockStatus; punched: 'in' | 'out' }
  | { type: 'punchFailed'; code: string }
  | { type: 'statusRefreshed'; status: KioskTimeclockStatus }
  | { type: 'badgeNew' }
  | { type: 'badgeExisting' }
  | { type: 'printingDone' }
  | { type: 'verifyContinue' }
  | { type: 'back' }
  | { type: 'reset' };

/** A screen never outlives the person at it: 20 s without a touch or key
 *  returns to the start. */
export const IDLE_MS = 20_000;
/** All Set returns to the start on its own after this long. */
export const DONE_MS = 8_000;
/** The Printing placeholder advances to Verify after this long. */
export const PRINTING_MS = 3_000;

const NOTICE_CHANGED = 'Your status changed. Please choose again.';
const ERROR_UNREACHABLE = "Can't reach the portal. Your punch was not recorded. Try again.";
const ERROR_OTHER = 'Something went wrong. Your punch was not recorded. Try again.';

export function START_STEP(mode: FlowMode): Step {
  return mode === 'station' ? 'welcome' : 'name';
}

export function initialState(mode: FlowMode): FlowState {
  return {
    mode, step: START_STEP(mode), status: null, busy: false, error: null, notice: null, punched: null,
    learningOverrideId: null, learningLinkSent: false,
  };
}

/** Unsigned learning for this clock-in: something is outstanding. */
function hasOutstanding(status: KioskTimeclockStatus): boolean {
  return (status.learning?.outstanding.length ?? 0) > 0;
}

const ERROR_READ_ONLY = 'The portal is in read-only mode. Your punch was not recorded. Try again shortly.';

function failureText(code: string): string {
  if (code === 'network' || code === 'edge_offline') return ERROR_UNREACHABLE;
  // a laptop kiosk signed in while offline can't punch until it signs in online
  if (code === 'cloud_sign_in_required') return CLOUD_SIGN_IN_TEXT;
  if (code === 'read_only_mode') return ERROR_READ_ONLY;
  return ERROR_OTHER;
}

/** The actions that start a punch. While one is in flight (`busy`) they
 *  change nothing, so a double tap can never send a second punch: the
 *  component sends only when an action takes the state into busy. */
const STARTS_PUNCH = new Set<FlowAction['type']>(
  ['chooseIn', 'chooseOut', 'punchStarted', 'learningOverride'],
);

export function reducer(state: FlowState, action: FlowAction): FlowState {
  if (state.busy && STARTS_PUNCH.has(action.type)) return state;
  switch (action.type) {
    case 'enterName':
      return state.step === 'welcome' ? { ...state, step: 'name' } : state;
    case 'identified':
      return {
        ...state, step: 'confirm', status: action.status, busy: false, error: null, notice: null, punched: null,
        learningOverrideId: null, learningLinkSent: false,
      };
    case 'confirmNo':
      return { ...state, step: 'name' };
    case 'confirmYes':
      return { ...state, step: 'action' };
    case 'chooseOut':
      return state.status?.clocked_in ? { ...state, step: 'clockOut', error: null, notice: null } : state;
    case 'chooseIn':
      if (!state.status || state.status.clocked_in) return state;
      // Unsigned learning stops the punch at the warning; otherwise the
      // component punches straight away (no second confirm to clock in).
      return hasOutstanding(state.status)
        ? { ...state, step: 'learning', error: null, notice: null }
        : { ...state, busy: true, error: null, notice: null };
    case 'learningOverride':
      // The admin's override is made; clock in with it.
      return state.step === 'learning' && state.status && !state.status.clocked_in
        ? { ...state, busy: true, error: null, learningOverrideId: action.overrideId }
        : state;
    case 'learningLinkSent':
      return state.step === 'learning' ? { ...state, learningLinkSent: true } : state;
    case 'learningCancel':
      return state.step === 'learning' ? initialState(state.mode) : state;
    case 'punchStarted':
      return { ...state, busy: true, error: null };
    case 'punchSucceeded':
      return {
        ...state,
        step: action.punched === 'in' ? 'badge' : 'done',
        status: action.status,
        punched: action.punched,
        busy: false,
        error: null,
        notice: null,
      };
    case 'punchFailed':
      if (action.code === 'already_clocked_in' || action.code === 'not_clocked_in') {
        return { ...state, step: 'action', busy: false, error: null, notice: NOTICE_CHANGED };
      }
      return { ...state, busy: false, error: failureText(action.code), notice: null };
    case 'statusRefreshed':
      return { ...state, status: action.status, busy: false };
    case 'badgeNew':
      return { ...state, step: 'printing' };
    case 'printingDone':
      return { ...state, step: 'verify' };
    case 'verifyContinue':
    case 'badgeExisting':
      return { ...state, step: 'done' };
    case 'back':
      switch (state.step) {
        case 'confirm': return { ...state, step: 'name' };
        case 'name': return state.mode === 'station' ? { ...state, step: 'welcome' } : state;
        case 'action': return { ...state, step: 'confirm' };
        case 'clockOut': return { ...state, step: 'action', error: null };
        default: return state;
      }
    case 'reset':
      return initialState(state.mode);
  }
}
