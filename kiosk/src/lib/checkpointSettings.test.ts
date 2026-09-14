// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  defaultCheckpoint, effectiveCheckpoint, readCheckpoint, useCheckpoint, writeCheckpoint,
} from './checkpointSettings';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

it('each checkpoint has its own default and its own storage key', () => {
  expect(defaultCheckpoint('enroll')).toBe('pre_stage');
  expect(defaultCheckpoint('containerPack')).toBe('in_container');
  expect(defaultCheckpoint('containerUnpack')).toBe('un_pack');
  expect(readCheckpoint('enroll')).toBe('pre_stage');
  expect(readCheckpoint('containerPack')).toBe('in_container');
  expect(readCheckpoint('containerUnpack')).toBe('un_pack');
});

it('write then read round-trips, one key at a time', () => {
  expect(writeCheckpoint('enroll', 'staged')).toBe(true);
  expect(readCheckpoint('enroll')).toBe('staged');
  // The enroll key predates this module and is kept verbatim, so a kiosk
  // already configured does not silently revert to the default.
  expect(localStorage.getItem('ss.kiosk.enrollStatus')).toBe('staged');
  // The other two are untouched by it.
  expect(readCheckpoint('containerPack')).toBe('in_container');

  expect(writeCheckpoint('containerPack', 'racked')).toBe(true);
  expect(localStorage.getItem('ss.kiosk.containerPackStatus')).toBe('racked');
  expect(writeCheckpoint('containerUnpack', 'received')).toBe(true);
  expect(localStorage.getItem('ss.kiosk.containerUnpackStatus')).toBe('received');
  expect(readCheckpoint('enroll')).toBe('staged');
});

it('a thrown storage leaves the default in place and writeCheckpoint returns false', () => {
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(writeCheckpoint('containerPack', 'staged')).toBe(false);
  expect(readCheckpoint('containerPack')).toBe('in_container');
  setItem.mockRestore();
  getItem.mockRestore();
});

it('falls back to that checkpoint\'s own default when the key is no longer offered', () => {
  const offered = ['pre_stage', 'staged', 'in_container', 'un_pack'];
  expect(effectiveCheckpoint('enroll', 'staged', offered)).toBe('staged');
  expect(effectiveCheckpoint('enroll', 'retired_checkpoint', offered)).toBe('pre_stage');
  expect(effectiveCheckpoint('containerPack', 'retired_checkpoint', offered)).toBe('in_container');
  expect(effectiveCheckpoint('containerUnpack', 'retired_checkpoint', offered)).toBe('un_pack');
  // Nothing offered yet (options still loading): the stored key stands.
  expect(effectiveCheckpoint('enroll', 'staged', [])).toBe('staged');
});

function Probe({ id }: { id: 'enroll' | 'containerPack' }) {
  const [key, setKey] = useCheckpoint(id);
  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'state' }, key),
    createElement('button', { type: 'button', onClick: () => setKey('staged') }, 'set'),
  );
}

it('the hook reflects an external write and its setter persists', async () => {
  const user = userEvent.setup();
  render(createElement(Probe, { id: 'containerPack' }));
  expect(screen.getByTestId('state').textContent).toBe('in_container');

  act(() => {
    writeCheckpoint('containerPack', 'racked');
  });
  expect(screen.getByTestId('state').textContent).toBe('racked');

  await user.click(screen.getByRole('button', { name: 'set' }));
  expect(screen.getByTestId('state').textContent).toBe('staged');
  expect(localStorage.getItem('ss.kiosk.containerPackStatus')).toBe('staged');
});

it('a write to one checkpoint never changes what another hook reports', () => {
  render(createElement(Probe, { id: 'enroll' }));
  expect(screen.getByTestId('state').textContent).toBe('pre_stage');
  act(() => {
    writeCheckpoint('containerUnpack', 'received');
  });
  expect(screen.getByTestId('state').textContent).toBe('pre_stage');
});
