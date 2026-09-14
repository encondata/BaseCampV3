// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  DEFAULT_ENROLL_STATUS, effectiveEnrollStatus, readEnrollStatus, useEnrollStatus,
  writeEnrollStatus,
} from './enrollSettings';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

it('defaults to pre_stage when nothing is stored', () => {
  expect(DEFAULT_ENROLL_STATUS).toBe('pre_stage');
  expect(readEnrollStatus()).toBe('pre_stage');
});

it('write then read round-trips', () => {
  expect(writeEnrollStatus('staged')).toBe(true);
  expect(readEnrollStatus()).toBe('staged');
  expect(localStorage.getItem('ss.kiosk.enrollStatus')).toBe('staged');
});

it('a thrown storage leaves the default in place and writeEnrollStatus returns false', () => {
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(writeEnrollStatus('staged')).toBe(false);
  expect(readEnrollStatus()).toBe('pre_stage');
  setItem.mockRestore();
  getItem.mockRestore();
});

it('falls back to the default when the stored checkpoint is no longer offered', () => {
  const offered = ['pre_stage', 'staged'];
  expect(effectiveEnrollStatus('staged', offered)).toBe('staged');
  expect(effectiveEnrollStatus('retired_checkpoint', offered)).toBe('pre_stage');
  // Nothing offered yet (options still loading): the stored key stands.
  expect(effectiveEnrollStatus('staged', [])).toBe('staged');
});

function Probe() {
  const [key, setKey] = useEnrollStatus();
  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'state' }, key),
    createElement('button', { type: 'button', onClick: () => setKey('staged') }, 'set'),
  );
}

it('the hook reflects an external write and its setter persists', async () => {
  const user = userEvent.setup();
  render(createElement(Probe));
  expect(screen.getByTestId('state').textContent).toBe('pre_stage');

  act(() => {
    writeEnrollStatus('cage_exit');
  });
  expect(screen.getByTestId('state').textContent).toBe('cage_exit');

  await user.click(screen.getByRole('button', { name: 'set' }));
  expect(screen.getByTestId('state').textContent).toBe('staged');
  expect(localStorage.getItem('ss.kiosk.enrollStatus')).toBe('staged');
});
