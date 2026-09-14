// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import { readDevMode, useDevMode, writeDevMode } from './devMode';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

it('defaults to off', () => {
  expect(readDevMode()).toBe(false);
});

it('write then read round-trips', () => {
  expect(writeDevMode(true)).toBe(true);
  expect(readDevMode()).toBe(true);
  expect(writeDevMode(false)).toBe(true);
  expect(readDevMode()).toBe(false);
});

it('a thrown storage leaves it off and writeDevMode returns false', () => {
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(writeDevMode(true)).toBe(false);
  expect(readDevMode()).toBe(false);
  setItem.mockRestore();
  getItem.mockRestore();
});

function Probe() {
  const [on, setOn] = useDevMode();
  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'state' }, on ? 'on' : 'off'),
    createElement('button', { type: 'button', onClick: () => setOn(!on) }, 'toggle'),
  );
}

it('the hook reflects an external write and its setter persists', async () => {
  const user = userEvent.setup();
  render(createElement(Probe));
  expect(screen.getByTestId('state').textContent).toBe('off');

  act(() => {
    writeDevMode(true);
  });
  expect(screen.getByTestId('state').textContent).toBe('on');

  await user.click(screen.getByRole('button', { name: 'toggle' }));
  expect(screen.getByTestId('state').textContent).toBe('off');
  expect(localStorage.getItem('ss.kiosk.devMode')).toBe('false');
});
