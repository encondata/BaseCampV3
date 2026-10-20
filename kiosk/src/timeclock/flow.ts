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
 */

import type { KioskTimeclockStatus } from '../lib/api';

export type FlowMode = 'station' | 'kiosk';

export type Step =
  | 'welcome' | 'name' | 'confirm' | 'action' | 'clockOut'
  | 'badge' | 'printing' | 'verify' | 'done';

export interface FlowState {
  mode: FlowMode;
  step: Step;
  status: KioskTimeclockStatus | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  punched: 'in' | 'out' | null;
}

export type FlowAction =
  | { type: 'identified'; status: KioskTimeclockStatus }
  | { type: 'confirmYes' }
  | { type: 'confirmNo' }
  | { type: 'chooseIn' }
  | { type: 'chooseOut' }
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
  };
}

function failureText(code: string): string {
  return code === 'network' || code === 'edge_offline' ? ERROR_UNREACHABLE : ERROR_OTHER;
}

export function reducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'identified':
      return {
        ...state, step: 'confirm', status: action.status, busy: false, error: null, notice: null, punched: null,
      };
    case 'confirmNo':
      return { ...state, step: 'name' };
    case 'confirmYes':
      return { ...state, step: 'action' };
    case 'chooseOut':
      return state.status?.clocked_in ? { ...state, step: 'clockOut', error: null, notice: null } : state;
    case 'chooseIn':
      // The component punches straight away (no second confirm to clock in).
      return state.status && !state.status.clocked_in
        ? { ...state, busy: true, error: null, notice: null }
        : state;
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
      return { ...state, busy: false, error: failureText(action.code) };
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
