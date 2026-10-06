// @vitest-environment jsdom
/**
 * ComboBox.tsx: the pure `shouldDropUp` flip-decision helper that decides
 * whether the option menu should open upward instead of downward when
 * there isn't enough room below the trigger, plus a couple of Escape-key
 * behavior tests — a host modal (BulkContainersModal) that both listens
 * for Escape itself and hosts ComboBoxes needs Escape, while the list is
 * open, to close only the list and not bubble up as a "close the whole
 * dialog" keypress too. Last, the opt-in `portal` menu: rendered under
 * document.body, selectable by mousedown, closed by a scroll that moves its
 * trigger (a scroll that leaves the trigger in place — focus scrolling the
 * field into view — keeps it open).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ComboBox, { shouldDropUp } from './ComboBox';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

interface Box { left: number; top: number; width: number; height: number }

const domRect = ({ left, top, width, height }: Box) => ({
  left, top, width, height, right: left + width, bottom: top + height,
  x: left, y: top, toJSON: () => ({}),
} as DOMRect);

/** jsdom lays nothing out: pin an element's rect to whatever `get()` says now. */
function pinRect(el: Element, get: () => Box) {
  el.getBoundingClientRect = () => domRect(get());
}

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

  it('a mousedown on the portaled menu itself (padding, scrollbar) keeps it open', () => {
    render(<ComboBox portal value="" onChange={() => {}} options={OPTIONS} ariaLabel="Pick" />);
    fireEvent.focus(screen.getByLabelText('Pick'));
    fireEvent.mouseDown(screen.getByText('Alpha').closest('.combo-menu')!);
    expect(screen.queryByText('Alpha')).not.toBeNull();
  });

  it('a window scroll that moves the trigger, or a resize, closes it; scrolling the list itself does not', () => {
    const { container } = render(
      <ComboBox portal value="" onChange={() => {}} options={OPTIONS} ariaLabel="Pick" />);
    let top = 100;
    pinRect(container.querySelector('.combo-wrap')!, () => ({ left: 10, top, width: 200, height: 30 }));
    const input = screen.getByLabelText('Pick');
    fireEvent.focus(input);
    fireEvent.scroll(screen.getByText('Alpha').closest('.combo-menu')!);
    expect(screen.getByText('Alpha')).toBeTruthy();
    top = 60;   // the page scrolled the trigger up by 40px
    fireEvent.scroll(window);
    expect(screen.queryByText('Alpha')).toBeNull();

    fireEvent.click(input);
    expect(screen.getByText('Alpha')).toBeTruthy();
    fireEvent(window, new Event('resize'));
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('a window scroll that leaves the trigger where it was keeps it open', () => {
    const { container } = render(
      <ComboBox portal value="" onChange={() => {}} options={OPTIONS} ariaLabel="Pick" />);
    pinRect(container.querySelector('.combo-wrap')!, () => ({ left: 10, top: 100, width: 200, height: 30 }));
    fireEvent.focus(screen.getByLabelText('Pick'));
    fireEvent.scroll(window);
    expect(screen.getByText('Alpha')).toBeTruthy();
  });

  // The first open portals to document.body (the shell isn't known until the
  // layout effect finds it) and then moves into the .portal-shell. The drop
  // direction must be measured again there: under document.body the shell's
  // styles don't reach the menu, so its first measurement is not its real one.
  it('inside a .portal-shell (no card), the menu ends up in the shell and is measured there', () => {
    const below = 238;   // room under the trigger: short of 260, plenty for a 100px menu
    const wrapBox = { left: 10, top: window.innerHeight - below - 30, width: 200, height: 30 };
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function rect(this: HTMLElement) {
        if (this.classList.contains('combo-wrap')) return domRect(wrapBox);
        if (this.classList.contains('combo-menu') && this.parentElement?.classList.contains('portal-shell')) {
          return domRect({ left: 0, top: 0, width: 200, height: 100 });
        }
        return domRect({ left: 0, top: 0, width: 0, height: 0 });
      });
    try {
      render(
        <div className="portal-shell" data-testid="shell">
          <ComboBox portal value="" onChange={() => {}} options={OPTIONS} ariaLabel="Pick" />
        </div>,
      );
      fireEvent.focus(screen.getByLabelText('Pick'));
      const menu = screen.getByText('Alpha').closest('.combo-menu') as HTMLElement;
      expect(menu.parentElement).toBe(screen.getByTestId('shell'));
      // measured in the shell (100px fits in 238px): it opens downward
      expect(menu.classList.contains('drop-up')).toBe(false);
      expect(menu.style.top).toBe(`${wrapBox.top + wrapBox.height + 6}px`);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('inside a .modal-card', () => {
  afterEach(cleanup);

  const OPTIONS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Bravo' }];

  // No `portal` prop: the card's overflow-y:auto would clip an in-place
  // menu, so the ComboBox portals itself whenever it sits inside one.
  const renderInCard = (onChange: (v: string) => void = () => {}) => render(
    <div>
      <div className="modal-card" data-testid="card">
        <ComboBox value="" onChange={onChange} options={OPTIONS} ariaLabel="Pick" />
      </div>
      <button type="button">outside</button>
    </div>,
  );

  it('renders the menu under document.body with fixed positioning, outside the card', () => {
    renderInCard();
    fireEvent.focus(screen.getByLabelText('Pick'));
    const menu = screen.getByText('Alpha').closest('.combo-menu') as HTMLElement;
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getByTestId('card').contains(menu)).toBe(false);
    expect(menu.style.position).toBe('fixed');
  });

  it('selects an option by mousedown and closes the menu', () => {
    const onChange = vi.fn();
    renderInCard(onChange);
    fireEvent.focus(screen.getByLabelText('Pick'));
    fireEvent.mouseDown(screen.getByText('Bravo'));
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('ArrowDown then Enter selects the second option', () => {
    const onChange = vi.fn();
    renderInCard(onChange);
    const input = screen.getByLabelText('Pick');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('a mousedown outside the ComboBox and the menu closes it', () => {
    renderInCard();
    fireEvent.focus(screen.getByLabelText('Pick'));
    expect(screen.getByText('Alpha')).toBeTruthy();
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('scrolling the menu list keeps it open; a card scroll that moves the trigger closes it', () => {
    const { container } = renderInCard();
    let top = 300;
    pinRect(container.querySelector('.combo-wrap')!, () => ({ left: 40, top, width: 240, height: 34 }));
    fireEvent.focus(screen.getByLabelText('Pick'));
    fireEvent.scroll(screen.getByText('Alpha').closest('.combo-menu')!);
    expect(screen.getByText('Alpha')).toBeTruthy();
    top = 220;   // the card scrolled the trigger up by 80px
    fireEvent.scroll(screen.getByTestId('card'));
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  // Tabbing to a field below the card's visible part makes the browser
  // scroll the card during focus; that scroll event arrives a frame later,
  // after the menu was placed from the already-scrolled trigger. The trigger
  // hasn't moved since, so the menu must not flash open and shut.
  it('a card scroll that leaves the trigger where it was (focus scrolled it into view) keeps it open', () => {
    const { container } = renderInCard();
    pinRect(container.querySelector('.combo-wrap')!, () => ({ left: 40, top: 300, width: 240, height: 34 }));
    fireEvent.focus(screen.getByLabelText('Pick'));
    fireEvent.scroll(screen.getByTestId('card'));
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByLabelText('Pick').getAttribute('aria-expanded')).toBe('true');
  });

  it('typing into the input while closed still opens a portaled menu', () => {
    renderInCard();
    fireEvent.change(screen.getByLabelText('Pick'), { target: { value: 'br' } });
    const menu = screen.getByText('Bravo').closest('.combo-menu') as HTMLElement;
    expect(menu.parentElement).toBe(document.body);
  });

  // The theme tokens (--surface, --paper-line, --text-dark, --accent-rgb, the
  // dark palette) live on .portal-shell, not on :root, so a menu parked under
  // document.body would render unthemed: no border, no active highlight, a
  // white surface in dark mode. Inside the shell it inherits them.
  it('portals into the enclosing .portal-shell so the theme tokens still apply', () => {
    render(
      <div className="portal-shell" data-testid="shell">
        <div className="modal-card" data-testid="card">
          <ComboBox value="" onChange={() => {}} options={OPTIONS} ariaLabel="Pick" />
        </div>
      </div>,
    );
    fireEvent.focus(screen.getByLabelText('Pick'));
    const menu = screen.getByText('Alpha').closest('.combo-menu') as HTMLElement;
    expect(menu.parentElement).toBe(screen.getByTestId('shell'));
    expect(screen.getByTestId('card').contains(menu)).toBe(false);
    expect(menu.style.position).toBe('fixed');
    // and an option is still selectable by mousedown from there
    fireEvent.mouseDown(screen.getByText('Bravo'));
    expect(screen.queryByText('Alpha')).toBeNull();
  });
});

describe('onSearch (the caller searches the server)', () => {
  afterEach(cleanup);

  it('reports the typed text and shows the options as given, without filtering them again', () => {
    const onSearch = vi.fn();
    // the server matched "ada" by email — the label doesn't contain it
    const OPTIONS = [{ value: 'p1', label: 'Augusta King' }];
    render(<ComboBox value="" onChange={() => {}} options={OPTIONS} onSearch={onSearch} ariaLabel="Person" />);
    const input = screen.getByLabelText('Person');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'ada' } });
    expect(onSearch).toHaveBeenLastCalledWith('ada');
    expect(screen.getByText('Augusta King')).toBeTruthy();
  });

  it('reports an empty search when the list closes', () => {
    const onSearch = vi.fn();
    render(<ComboBox value="" onChange={() => {}} options={[{ value: 'a', label: 'Alpha' }]}
                     onSearch={onSearch} ariaLabel="Person" />);
    const input = screen.getByLabelText('Person');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'al' } });
    fireEvent.mouseDown(screen.getByText('Alpha'));
    expect(onSearch).toHaveBeenLastCalledWith('');
  });
});
