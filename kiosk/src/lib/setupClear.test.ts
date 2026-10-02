// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';

import { readKioskSetup, writeKioskSetup } from './kioskSetup';
import { readSetupState, writeSetupState } from './setupState';
import {
  applySetupClear, dismissSetupClearNotice, pendingAck, readSetupClear, settleAck,
} from './setupClear';

beforeEach(() => localStorage.clear());

const SELECTION = {
  initiativeId: 'i1', initiativeName: 'Move', siteId: 's1', siteName: 'Site',
  siteRole: 'source' as const, scanStatus: 'packed', scanLabel: 'Packed',
};

it('applies a new id once: clears the setup, marks incomplete, raises the notice', () => {
  writeSetupState('complete');
  writeKioskSetup(SELECTION);
  expect(readKioskSetup()).not.toBeNull();
  expect(applySetupClear('a')).toBe(true);
  expect(readSetupState()).toBe('incomplete');
  expect(readKioskSetup()).toBeNull();
  expect(readSetupClear()).toEqual({ id: 'a', acked: false, notice: true });
  expect(applySetupClear('a')).toBe(false);          // same id never re-applies
  expect(pendingAck()).toBe('a');
});

it('the ack is pending until the server stops asking for that id', () => {
  applySetupClear('a');
  settleAck('a');                                    // still asking → keep sending
  expect(pendingAck()).toBe('a');
  settleAck(null);                                   // server stopped asking
  expect(pendingAck()).toBeNull();
  expect(readSetupClear()?.acked).toBe(true);
});

it('a newer id is applied after an older one', () => {
  applySetupClear('a');
  settleAck(null);
  writeSetupState('complete');
  expect(applySetupClear('b')).toBe(true);
  expect(readSetupState()).toBe('incomplete');
  expect(pendingAck()).toBe('b');
});

it('dismissing the notice keeps the id (no re-apply) and survives reload', () => {
  applySetupClear('a');
  dismissSetupClearNotice();
  expect(readSetupClear()).toEqual({ id: 'a', acked: false, notice: false });
  expect(applySetupClear('a')).toBe(false);
});
