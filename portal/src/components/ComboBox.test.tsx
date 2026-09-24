// @vitest-environment jsdom
/**
 * ComboBox.tsx: the pure `shouldDropUp` flip-decision helper that decides
 * whether the option menu should open upward instead of downward when
 * there isn't enough room below the trigger, plus a couple of Escape-key
 * behavior tests — a host modal (BulkContainersModal) that both listens
 * for Escape itself and hosts ComboBoxes needs Escape, while the list is
 * open, to close only the list and not bubble up as a "close the whole
 * dialog" keypress too. Last, the opt-in `portal` menu: rendered under
 * document.body, selectable by mousedown, closed by an outside scroll.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ComboBox, { shouldDropUp } from './ComboBox';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

describe('shouldDropUp', () => {
  it('stays down when there is plenty of room below', () => {
    expect(shouldDropUp({ spaceBelow: 400, spaceAbove: 100, neededHeight: 260 })).toBe(false);
  });

  it('flips up when space below is short and space above is greater', () => {
    expect(shouldDropUp({ spaceBelow: 80, spaceAbove: 300, neededHeight: 260 })).toBe(true);
  });

  it('stays down when space below is short but space above is also short (or shorter)', () => {
    expect(shouldDropUp({ spaceBelow: 80, spaceAbove: 60, neededHeight: 260 })).toBe(false);
  });

  it('stays down when space below is short but space above is exactly equal', () => {
    expect(shouldDropUp({ spaceBelow: 80, spaceAbove: 80, neededHeight: 260 })).toBe(false);
  });

  it('stays down when space below already meets the needed height', () => {
    expect(shouldDropUp({ spaceBelow: 260, spaceAbove: 1000, neededHeight: 260 })).toBe(false);
  });

  it('flips up right at the boundary where space below is just under needed height', () => {
    expect(shouldDropUp({ spaceBelow: 259, spaceAbove: 260, neededHeight: 260 })).toBe(true);
  });
});

describe('Escape', () => {
  afterEach(cleanup);

  const OPTIONS = [{ value: 'a', label: 'Alpha' }];

  it('while the list is open: closes the list and marks the keydown defaultPrevented', async () => {
    const user = userEvent.setup();
    render(<ComboBox value="" onChange={() => {}} options={OPTIONS} />);
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByText('Alpha')).toBeTruthy();

    let seenDefaultPrevented: boolean | null = null;
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') seenDefaultPrevented = e.defaultPrevented;
    };
    document.addEventListener('keydown', onDocKey);
    try {
      await user.keyboard('{Escape}');
    } finally {
      document.removeEventListener('keydown', onDocKey);
    }

    expect(screen.queryByText('Alpha')).toBeNull();     // list closed
    expect(seenDefaultPrevented).toBe(true);            // scoped: a host's own Escape listener should skip this
  });

  it('with no list open (the combobox never focused/opened), a global Escape is left alone', async () => {
    const user = userEvent.setup();
    render(<ComboBox value="" onChange={() => {}} options={OPTIONS} />);
    // No interaction at all — focusing the input opens its list (onFocus
    // calls openList), so "closed" here means never having touched it;
    // Escape is dispatched to whatever's focused by default (body).

    let seenDefaultPrevented: boolean | null = null;
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') seenDefaultPrevented = e.defaultPrevented;
    };
    document.addEventListener('keydown', onDocKey);
    try {
      await user.keyboard('{Escape}');
    } finally {
      document.removeEventListener('keydown', onDocKey);
    }

    expect(seenDefaultPrevented).toBe(false);
  });
});

describe('portal', () => {
  afterEach(cleanup);

  const OPTIONS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Bravo' }];

  it('renders the menu under document.body, not inside the wrapper', () => {
    const { container } = render(
      <ComboBox portal value="" onChange={() => {}} options={OPTIONS} ariaLabel="Pick" />);
    fireEvent.focus(screen.getByLabelText('Pick'));
    const menu = screen.getByText('Alpha').closest('.combo-menu') as HTMLElement;
    expect(menu.parentElement).toBe(document.body);
    expect(container.querySelector('.combo-wrap')!.contains(menu)).toBe(false);
    expect(menu.style.position).toBe('fixed');
  });

  it('without portal, the menu stays inside the wrapper', () => {
    const { container } = render(
      <ComboBox value="" onChange={() => {}} options={OPTIONS} ariaLabel="Pick" />);
    fireEvent.focus(screen.getByLabelText('Pick'));
    const menu = screen.getByText('Alpha').closest('.combo-menu') as HTMLElement;
    expect(container.querySelector('.combo-wrap')!.contains(menu)).toBe(true);
    expect(menu.getAttribute('style')).toBeNull();
  });

  it('selects an option by mousedown (the outside-click guard sees the portaled menu as inside)', () => {
    const onChange = vi.fn();
    render(<ComboBox portal value="" onChange={onChange} options={OPTIONS} ariaLabel="Pick" />);
    fireEvent.focus(screen.getByLabelText('Pick'));
    fireEvent.mouseDown(screen.getByText('Bravo'));
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('a window scroll or resize closes it; scrolling the list itself does not', () => {
    render(<ComboBox portal value="" onChange={() => {}} options={OPTIONS} ariaLabel="Pick" />);
    const input = screen.getByLabelText('Pick');
    fireEvent.focus(input);
    fireEvent.scroll(screen.getByText('Alpha').closest('.combo-menu')!);
    expect(screen.getByText('Alpha')).toBeTruthy();
    fireEvent.scroll(window);
    expect(screen.queryByText('Alpha')).toBeNull();

    fireEvent.click(input);
    expect(screen.getByText('Alpha')).toBeTruthy();
    fireEvent(window, new Event('resize'));
    expect(screen.queryByText('Alpha')).toBeNull();
  });
});
