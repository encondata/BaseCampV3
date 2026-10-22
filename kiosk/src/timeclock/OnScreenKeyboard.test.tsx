// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import OnScreenKeyboard from './OnScreenKeyboard';

afterEach(() => cleanup());

function setup(value = '') {
  const props = { value, onKey: vi.fn(), onBackspace: vi.fn(), onSearch: vi.fn() };
  render(<OnScreenKeyboard {...props} />);
  return props;
}

const rowText = () => [...document.querySelectorAll('.tcx-kb-row')].map(
  (row) => [...row.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent).join(' '),
);

it('lays out the QWERTY rows with shift, backspace, 123, Space and Search', () => {
  setup('x');
  expect(rowText()).toEqual([
    'Q W E R T Y U I O P',
    'A S D F G H J K L',
    'Shift Z X C V B N M Backspace',
    'Numbers Space Search',
  ]);
  expect(screen.getByRole('button', { name: 'Numbers' }).textContent).toBe('123');
});

it('types a capital at the start of a word and lower case after it', async () => {
  const first = setup('');
  await userEvent.click(screen.getByRole('button', { name: 'T' }));
  expect(first.onKey).toHaveBeenLastCalledWith('T');
  cleanup();
  const later = setup('T');
  await userEvent.click(screen.getByRole('button', { name: 'I' }));
  expect(later.onKey).toHaveBeenLastCalledWith('i');
  cleanup();
  const afterSpace = setup('Tina ');
  await userEvent.click(screen.getByRole('button', { name: 'N' }));
  expect(afterSpace.onKey).toHaveBeenLastCalledWith('N');
});

it('Shift capitalizes the next letter only', async () => {
  const props = setup('ab');
  const shift = screen.getByRole('button', { name: 'Shift' });
  await userEvent.click(shift);
  expect(shift.getAttribute('aria-pressed')).toBe('true');
  await userEvent.click(screen.getByRole('button', { name: 'Q' }));
  await userEvent.click(screen.getByRole('button', { name: 'Q' }));
  expect(props.onKey.mock.calls).toEqual([['Q'], ['q']]);
});

it('Space, Backspace and Search', async () => {
  const props = setup('ab');
  await userEvent.click(screen.getByRole('button', { name: 'Space' }));
  await userEvent.click(screen.getByRole('button', { name: 'Backspace' }));
  await userEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(props.onKey).toHaveBeenCalledWith(' ');
  expect(props.onBackspace).toHaveBeenCalledTimes(1);
  expect(props.onSearch).toHaveBeenCalledTimes(1);
});

it('123 switches to digits and name punctuation, ABC switches back', async () => {
  const props = setup('ab');
  await userEvent.click(screen.getByRole('button', { name: 'Numbers' }));
  await userEvent.click(screen.getByRole('button', { name: '7' }));
  await userEvent.click(screen.getByRole('button', { name: '-' }));
  expect(props.onKey.mock.calls).toEqual([['7'], ['-']]);
  await userEvent.click(screen.getByRole('button', { name: 'Letters' }));
  expect(screen.getByRole('button', { name: 'Q' })).toBeTruthy();
});

it('keys never take focus from the input a badge reader types into', () => {
  setup();
  for (const name of ['Q', 'Shift', 'Backspace', 'Numbers', 'Space', 'Search']) {
    // fireEvent returns false when the default (moving focus) was prevented
    expect(fireEvent.mouseDown(screen.getByRole('button', { name }))).toBe(false);
  }
});

it('disabled turns every key off', () => {
  render(<OnScreenKeyboard value="" disabled onKey={vi.fn()} onBackspace={vi.fn()} onSearch={vi.fn()} />);
  for (const b of screen.getAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(true);
});
