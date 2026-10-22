import { describe, expect, it } from 'vitest';

import type { KioskTimeclockStatus } from '../lib/api';
import {
  DONE_MS, IDLE_MS, PRINTING_MS, START_STEP, initialState, reducer, type FlowState,
} from './flow';

const OFF: KioskTimeclockStatus = {
  person: { id: 'p-1', display_name: 'Alex Worker' } as KioskTimeclockStatus['person'],
  clocked_in: false, entry: null, last_entry: null, today_minutes: 0, today_entries: [],
};
const ON: KioskTimeclockStatus = { ...OFF, clocked_in: true };

const NETWORK = "Can't reach the portal. Your punch was not recorded. Try again.";
const OTHER = 'Something went wrong. Your punch was not recorded. Try again.';
const CHANGED = 'Your status changed. Please choose again.';

function at(step: FlowState['step'], over: Partial<FlowState> = {}, mode: FlowState['mode'] = 'station'): FlowState {
  return { ...initialState(mode), step, status: OFF, ...over };
}

describe('constants', () => {
  it('pins the timers', () => {
    expect(IDLE_MS).toBe(20_000);
    expect(DONE_MS).toBe(8_000);
    expect(PRINTING_MS).toBe(3_000);
  });
  it('starts on welcome in station mode and name in kiosk mode', () => {
    expect(START_STEP('station')).toBe('welcome');
    expect(START_STEP('kiosk')).toBe('name');
    expect(initialState('station')).toEqual({
      mode: 'station', step: 'welcome', status: null, busy: false, error: null, notice: null, punched: null,
    });
    expect(initialState('kiosk').step).toBe('name');
  });
});

describe('reducer', () => {
  it('enterName goes from welcome to name, and nowhere else', () => {
    expect(reducer(at('welcome'), { type: 'enterName' }).step).toBe('name');
    const confirm = at('confirm');
    expect(reducer(confirm, { type: 'enterName' })).toBe(confirm);
  });

  it('identified stores the status and goes to confirm, clearing error, notice and punched', () => {
    const s = reducer(
      at('name', { error: 'x', notice: 'y', punched: 'in', busy: true }),
      { type: 'identified', status: ON },
    );
    expect(s).toMatchObject({ step: 'confirm', status: ON, error: null, notice: null, punched: null, busy: false });
  });

  it('confirmNo and back from confirm return to name', () => {
    expect(reducer(at('confirm'), { type: 'confirmNo' }).step).toBe('name');
    expect(reducer(at('confirm'), { type: 'back' }).step).toBe('name');
  });

  it('back from name goes to welcome in station mode, and is a no-op in kiosk mode', () => {
    expect(reducer(at('name'), { type: 'back' }).step).toBe('welcome');
    const kiosk = at('name', {}, 'kiosk');
    expect(reducer(kiosk, { type: 'back' })).toEqual(kiosk);
  });

  it('confirmYes goes to action', () => {
    expect(reducer(at('confirm'), { type: 'confirmYes' }).step).toBe('action');
  });

  it('chooseOut goes to clockOut only when clocked in', () => {
    expect(reducer(at('action', { status: ON }), { type: 'chooseOut' }).step).toBe('clockOut');
    const off = at('action');
    expect(reducer(off, { type: 'chooseOut' })).toEqual(off);
  });

  it('chooseIn when not clocked in stays on action and goes busy', () => {
    const s = reducer(at('action'), { type: 'chooseIn' });
    expect(s).toMatchObject({ step: 'action', busy: true });
  });

  it('chooseIn is ignored when already clocked in', () => {
    const on = at('action', { status: ON });
    expect(reducer(on, { type: 'chooseIn' })).toEqual(on);
  });

  it('punchStarted sets busy and clears the error', () => {
    const s = reducer(at('clockOut', { status: ON, error: 'x' }), { type: 'punchStarted' });
    expect(s).toMatchObject({ step: 'clockOut', busy: true, error: null });
  });

  it('punchSucceeded in goes to badge; out goes to done', () => {
    const inn = reducer(at('action', { busy: true }), { type: 'punchSucceeded', status: ON, punched: 'in' });
    expect(inn).toMatchObject({ step: 'badge', status: ON, punched: 'in', busy: false, error: null });
    const out = reducer(at('clockOut', { status: ON, busy: true }), { type: 'punchSucceeded', status: OFF, punched: 'out' });
    expect(out).toMatchObject({ step: 'done', status: OFF, punched: 'out', busy: false });
  });

  it.each(['already_clocked_in', 'not_clocked_in'])('punchFailed %s returns to action with a notice', (code) => {
    const s = reducer(at('clockOut', { status: ON, busy: true }), { type: 'punchFailed', code });
    expect(s).toMatchObject({ step: 'action', busy: false, notice: CHANGED, error: null });
  });

  it('statusRefreshed replaces the status and keeps the notice', () => {
    const s = reducer(at('action', { notice: CHANGED }), { type: 'statusRefreshed', status: ON });
    expect(s).toMatchObject({ step: 'action', status: ON, notice: CHANGED, busy: false });
  });

  it.each(['network', 'edge_offline'])('punchFailed %s says the portal is unreachable', (code) => {
    const s = reducer(at('action', { busy: true }), { type: 'punchFailed', code });
    expect(s).toMatchObject({ step: 'action', busy: false, error: NETWORK });
  });

  it('punchFailed with any other code is the generic error and stays on the step', () => {
    const s = reducer(at('clockOut', { status: ON, busy: true }), { type: 'punchFailed', code: 'boom' });
    expect(s).toMatchObject({ step: 'clockOut', busy: false, error: OTHER });
  });

  it.each([
    ['cloud_sign_in_required', 'Sign in again while online to do this.'],
    ['read_only_mode', 'The portal is in read-only mode. Your punch was not recorded. Try again shortly.'],
  ])('punchFailed %s has its own message', (code, text) => {
    expect(reducer(at('action', { busy: true }), { type: 'punchFailed', code }).error).toBe(text);
  });

  it('a generic punchFailed clears an earlier notice', () => {
    const s = reducer(at('action', { busy: true, notice: CHANGED }), { type: 'punchFailed', code: 'network' });
    expect(s).toMatchObject({ busy: false, error: NETWORK, notice: null });
  });

  it.each([
    ['chooseIn', at('action', { busy: true })],
    ['chooseOut', at('action', { status: ON, busy: true })],
    ['punchStarted', at('clockOut', { status: ON, busy: true })],
  ] as const)('%s while busy is ignored, so a double tap never sends two punches', (type, busy) => {
    expect(reducer(busy, { type })).toBe(busy);
  });

  it('badge branches', () => {
    expect(reducer(at('badge'), { type: 'badgeNew' }).step).toBe('printing');
    expect(reducer(at('printing'), { type: 'printingDone' }).step).toBe('verify');
    expect(reducer(at('verify'), { type: 'verifyContinue' }).step).toBe('done');
    expect(reducer(at('badge'), { type: 'badgeExisting' }).step).toBe('done');
  });

  it('back from action goes to confirm and from clockOut to action', () => {
    expect(reducer(at('action'), { type: 'back' }).step).toBe('confirm');
    expect(reducer(at('clockOut', { status: ON }), { type: 'back' }).step).toBe('action');
  });

  it('back from badge stays on badge', () => {
    const s = at('badge', { punched: 'in' });
    expect(reducer(s, { type: 'back' })).toEqual(s);
  });

  it('reset returns to the initial state for the mode', () => {
    expect(reducer(at('done', { punched: 'out' }), { type: 'reset' })).toEqual(initialState('station'));
    expect(reducer(at('done', { punched: 'out' }, 'kiosk'), { type: 'reset' })).toEqual(initialState('kiosk'));
  });
});
