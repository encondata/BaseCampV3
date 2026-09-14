// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import {
  isSetupComplete,
  readSetupState,
  setupStateLabel,
  useKioskSetupState,
  writeSetupState,
} from './setupState';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

it('defaults to incomplete', () => {
  expect(readSetupState()).toBe('incomplete');
});

it('write then read round-trips each value', () => {
  expect(writeSetupState('complete')).toBe(true);
  expect(readSetupState()).toBe('complete');
  expect(writeSetupState('failed')).toBe(true);
  expect(readSetupState()).toBe('failed');
  expect(writeSetupState('incomplete')).toBe(true);
  expect(readSetupState()).toBe('incomplete');
});

it('an unknown stored value reads as incomplete', () => {
  localStorage.setItem('ss.kiosk.setupState', 'bogus');
  expect(readSetupState()).toBe('incomplete');
});

it('a thrown storage reads as incomplete and write returns false', () => {
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(writeSetupState('complete')).toBe(false);
  expect(readSetupState()).toBe('incomplete');
  setItem.mockRestore();
  getItem.mockRestore();
});

it('isSetupComplete is true only for complete', () => {
  expect(isSetupComplete('complete')).toBe(true);
  expect(isSetupComplete('incomplete')).toBe(false);
  expect(isSetupComplete('failed')).toBe(false);
});

it('setupStateLabel maps each state to its display label', () => {
  expect(setupStateLabel('incomplete')).toBe('Incomplete');
  expect(setupStateLabel('complete')).toBe('Complete');
  expect(setupStateLabel('failed')).toBe('Failed');
});

function Probe() {
  const [state, setState] = useKioskSetupState();
  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'state' }, state),
    createElement('button', { type: 'button', onClick: () => setState('complete') }, 'complete'),
  );
}

it('the hook reflects an external write and its setter persists', async () => {
  const user = userEvent.setup();
  render(createElement(Probe));
  expect(screen.getByTestId('state').textContent).toBe('incomplete');

  act(() => {
    writeSetupState('failed');
  });
  expect(screen.getByTestId('state').textContent).toBe('failed');

  await user.click(screen.getByRole('button', { name: 'complete' }));
  expect(screen.getByTestId('state').textContent).toBe('complete');
  expect(localStorage.getItem('ss.kiosk.setupState')).toBe('complete');
});
