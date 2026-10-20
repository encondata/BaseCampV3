// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import {
  clearKioskSetup,
  stationLabel,
  readKioskSetup,
  useKioskSetup,
  writeKioskSetup,
} from './kioskSetup';

const SELECTION = {
  initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration (demo)',
  siteId: 's-1', siteName: 'NAP11 Hall', siteRole: 'source' as const,
  scanStatus: 'rfid_1_cage_exit', scanLabel: 'RFID 1 - Cage Exit',
};

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

it('defaults to null', () => {
  expect(readKioskSetup()).toBeNull();
});

it('write then read round-trips', () => {
  expect(writeKioskSetup(SELECTION)).toBe(true);
  expect(readKioskSetup()).toEqual(SELECTION);
});

it('clear removes the saved selection', () => {
  writeKioskSetup(SELECTION);
  clearKioskSetup();
  expect(readKioskSetup()).toBeNull();
});

it('malformed stored JSON reads as null', () => {
  localStorage.setItem('ss.kiosk.setup', '{not json');
  expect(readKioskSetup()).toBeNull();
});

it('a stored value missing required fields reads as null', () => {
  localStorage.setItem('ss.kiosk.setup', JSON.stringify({ initiativeId: 'i-1' }));
  expect(readKioskSetup()).toBeNull();
});

it('a thrown storage leaves it null and write returns false', () => {
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(writeKioskSetup(SELECTION)).toBe(false);
  expect(readKioskSetup()).toBeNull();
  setItem.mockRestore();
  getItem.mockRestore();
});

function Probe() {
  const [selection, setSelection] = useKioskSetup();
  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'state' }, selection ? selection.initiativeName : 'none'),
    createElement('button', { type: 'button', onClick: () => setSelection(SELECTION) }, 'save'),
    createElement('button', { type: 'button', onClick: () => setSelection(null) }, 'clear'),
  );
}

it('the hook reflects an external write and its setter persists', async () => {
  const user = userEvent.setup();
  render(createElement(Probe));
  expect(screen.getByTestId('state').textContent).toBe('none');

  act(() => {
    writeKioskSetup(SELECTION);
  });
  expect(screen.getByTestId('state').textContent).toBe(SELECTION.initiativeName);

  await user.click(screen.getByRole('button', { name: 'clear' }));
  expect(screen.getByTestId('state').textContent).toBe('none');
  expect(localStorage.getItem('ss.kiosk.setup')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'save' }));
  expect(screen.getByTestId('state').textContent).toBe(SELECTION.initiativeName);
});

it('a selection with a station type and reader round-trips; an old one without them stays valid', () => {
  const rfid = {
    ...SELECTION, stationType: 'rfid' as const,
    reader: { ip: '10.0.0.5', serial: '1234ABCD', model: 'FX9600' },
  };
  writeKioskSetup(rfid);
  expect(readKioskSetup()).toEqual(rfid);
  localStorage.setItem('ss.kiosk.setup', JSON.stringify(SELECTION));
  expect(readKioskSetup()).toEqual(SELECTION);
});

it('an unknown station type reads as no station type', () => {
  localStorage.setItem('ss.kiosk.setup', JSON.stringify({ ...SELECTION, stationType: 'bogus' }));
  expect(readKioskSetup()?.stationType).toBeUndefined();
});

it('stationLabel names the station and the mode', () => {
  expect(stationLabel('rfid', 'Laptop')).toBe('RFID · Laptop');
  expect(stationLabel('label', 'Laptop')).toBe('Label Station · Laptop');
  expect(stationLabel(undefined, 'Laptop')).toBe('Laptop');
});

const NO_MOVE_CLOCK = {
  initiativeId: '', initiativeName: 'No move', siteId: '', siteName: 'No site',
  siteRole: 'none' as const, scanStatus: '', scanLabel: '', stationType: 'timeclock' as const,
};

it('a no-move Time Clock selection round-trips and keeps its station type', () => {
  expect(writeKioskSetup(NO_MOVE_CLOCK)).toBe(true);
  expect(readKioskSetup()).toEqual(NO_MOVE_CLOCK);
  const withSite = { ...NO_MOVE_CLOCK, siteId: 's-1', siteName: 'NAP11 Hall', siteRole: 'other' as const };
  writeKioskSetup(withSite);
  expect(readKioskSetup()).toEqual(withSite);
});

it('empty ids are only valid for a Time Clock station', () => {
  localStorage.setItem('ss.kiosk.setup', JSON.stringify({ ...NO_MOVE_CLOCK, stationType: 'rfid' }));
  expect(readKioskSetup()).toBeNull();
  localStorage.setItem('ss.kiosk.setup', JSON.stringify({ ...SELECTION, siteRole: 'none' }));
  expect(readKioskSetup()).toBeNull();
});

it('stationLabel names a Time Clock', () => {
  expect(stationLabel('timeclock', 'Laptop')).toBe('Time Clock · Laptop');
});
