// @vitest-environment jsdom
/**
 * TagInput.tsx: the suggestion menu inside a `.modal-card`. The card's
 * overflow-y:auto would clip an in-place menu, so TagInput portals it to
 * document.body there (fixed positioning, placed by the shared
 * useMenuPlacement hook). Outside a card the menu stays in place, as before.
 * A portaled menu closes on a resize or on a scroll that moves its trigger;
 * a scroll that leaves the trigger in place (focus scrolling the field into
 * view) keeps it open.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import TagInput from './TagInput';

const SUGGESTIONS = ['Alpha', 'Bravo'];

interface Box { left: number; top: number; width: number; height: number }

/** jsdom lays nothing out: pin an element's rect to whatever `get()` says now. */
function pinRect(el: Element, get: () => Box) {
  el.getBoundingClientRect = () => {
    const { left, top, width, height } = get();
    return {
      left, top, width, height, right: left + width, bottom: top + height,
      x: left, y: top, toJSON: () => ({}),
    } as DOMRect;
  };
}

afterEach(cleanup);

describe('inside a .modal-card', () => {
  const renderInCard = (onChange: (tags: string[]) => void = () => {}) => render(
    <div>
      <div className="modal-card" data-testid="card">
        <TagInput value={[]} onChange={onChange} suggestions={SUGGESTIONS} placeholder="Tags" />
      </div>
      <button type="button">outside</button>
    </div>,
  );

  it('renders the suggestion menu under document.body with fixed positioning, outside the card', () => {
    renderInCard();
    fireEvent.focus(screen.getByPlaceholderText('Tags'));
    const menu = screen.getByText('Alpha').closest('.combo-menu') as HTMLElement;
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getByTestId('card').contains(menu)).toBe(false);
    expect(menu.style.position).toBe('fixed');
  });

  it('portals into the enclosing .portal-shell so the theme tokens still apply', () => {
    // --surface, --paper-line, --accent-rgb and the dark palette live on
    // .portal-shell, not :root: a menu under document.body would be unthemed.
    render(
      <div className="portal-shell" data-testid="shell">
        <div className="modal-card" data-testid="card">
          <TagInput value={[]} onChange={() => {}} suggestions={SUGGESTIONS} placeholder="Tags" />
        </div>
      </div>,
    );
    fireEvent.focus(screen.getByPlaceholderText('Tags'));
    const menu = screen.getByText('Alpha').closest('.combo-menu') as HTMLElement;
    expect(menu.parentElement).toBe(screen.getByTestId('shell'));
    expect(screen.getByTestId('card').contains(menu)).toBe(false);
    expect(menu.style.position).toBe('fixed');
  });

  it('adds a suggestion by mousedown', () => {
    const onChange = vi.fn();
    renderInCard(onChange);
    fireEvent.focus(screen.getByPlaceholderText('Tags'));
    fireEvent.mouseDown(screen.getByText('Bravo'));
    expect(onChange).toHaveBeenCalledWith(['Bravo']);
  });

  it('a mousedown on the portaled menu itself keeps it open', () => {
    renderInCard();
    fireEvent.focus(screen.getByPlaceholderText('Tags'));
    fireEvent.mouseDown(screen.getByText('Alpha').closest('.combo-menu')!);
    expect(screen.queryByText('Alpha')).not.toBeNull();
  });

  it('a mousedown outside the TagInput and the menu closes it', () => {
    renderInCard();
    fireEvent.focus(screen.getByPlaceholderText('Tags'));
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('a window scroll that moves the field, or a resize, closes it; scrolling the menu itself does not', () => {
    const { container } = renderInCard();
    let top = 200;
    pinRect(container.querySelector('.tag-input-wrap')!, () => ({ left: 10, top, width: 300, height: 30 }));
    const input = screen.getByPlaceholderText('Tags');
    fireEvent.focus(input);
    fireEvent.scroll(screen.getByText('Alpha').closest('.combo-menu')!);
    expect(screen.getByText('Alpha')).toBeTruthy();
    top = 150;   // the page scrolled the field up by 50px
    fireEvent.scroll(window);
    expect(screen.queryByText('Alpha')).toBeNull();

    fireEvent.change(input, { target: { value: 'a' } });
    expect(screen.getByText('Alpha')).toBeTruthy();
    fireEvent(window, new Event('resize'));
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('after a scroll dismisses it, clicking the still-focused input reopens it', () => {
    const { container } = renderInCard();
    let top = 200;
    pinRect(container.querySelector('.tag-input-wrap')!, () => ({ left: 10, top, width: 300, height: 30 }));
    const input = screen.getByPlaceholderText('Tags');
    fireEvent.focus(input);
    top = 150;
    fireEvent.scroll(window);
    expect(screen.queryByText('Alpha')).toBeNull();
    fireEvent.click(input);
    const menu = screen.getByText('Alpha').closest('.combo-menu') as HTMLElement;
    expect(menu.parentElement).toBe(document.body);
  });

  it('re-places the menu when a new tag changes the field (a chip can wrap it onto another row)', () => {
    let rect = { left: 10, width: 300, top: 70, bottom: 100 };
    const onChange = vi.fn();
    const { container, rerender } = render(
      <div className="modal-card">
        <TagInput value={[]} onChange={onChange} suggestions={SUGGESTIONS} placeholder="Tags" />
      </div>,
    );
    const wrap = container.querySelector('.tag-input-wrap') as HTMLElement;
    wrap.getBoundingClientRect = () => ({
      ...rect, right: rect.left + rect.width, height: rect.bottom - rect.top,
      x: rect.left, y: rect.top, toJSON: () => ({}),
    } as DOMRect);
    fireEvent.focus(screen.getByPlaceholderText('Tags'));
    const menu = () => screen.getByText('Bravo').closest('.combo-menu') as HTMLElement;
    expect(menu().style.top).toBe('106px');

    // the chip wraps the field onto a second row: the wrapper is taller now
    fireEvent.mouseDown(screen.getByText('Alpha'));
    expect(onChange).toHaveBeenCalledWith(['Alpha']);
    rect = { left: 10, width: 300, top: 70, bottom: 130 };
    rerender(
      <div className="modal-card">
        <TagInput value={['Alpha']} onChange={onChange} suggestions={SUGGESTIONS} placeholder="Tags" />
      </div>,
    );
    expect(menu().style.top).toBe('136px');
  });

  it('a card scroll that moves the field closes it', () => {
    const { container } = renderInCard();
    let top = 300;
    pinRect(container.querySelector('.tag-input-wrap')!, () => ({ left: 10, top, width: 300, height: 30 }));
    fireEvent.focus(screen.getByPlaceholderText('Tags'));
    top = 240;   // the card scrolled the field up by 60px
    fireEvent.scroll(screen.getByTestId('card'));
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  // Tabbing to a field below the card's visible part scrolls the card during
  // focus; the scroll event lands a frame after the menu was placed from the
  // already-scrolled field, so the field hasn't moved since. Keep it open.
  it('a card scroll that leaves the field where it was (focus scrolled it into view) keeps it open', () => {
    const { container } = renderInCard();
    pinRect(container.querySelector('.tag-input-wrap')!, () => ({ left: 10, top: 300, width: 300, height: 30 }));
    fireEvent.focus(screen.getByPlaceholderText('Tags'));
    fireEvent.scroll(screen.getByTestId('card'));
    expect(screen.getByText('Alpha')).toBeTruthy();
  });
});

describe('outside a .modal-card', () => {
  it('the menu stays inside .tag-input-wrap with no inline style', () => {
    const { container } = render(
      <TagInput value={[]} onChange={() => {}} suggestions={SUGGESTIONS} placeholder="Tags" />);
    fireEvent.focus(screen.getByPlaceholderText('Tags'));
    const menu = screen.getByText('Alpha').closest('.combo-menu') as HTMLElement;
    expect(container.querySelector('.tag-input-wrap')!.contains(menu)).toBe(true);
    expect(menu.getAttribute('style')).toBeNull();
  });

  it('adds a suggestion by mousedown', () => {
    const onChange = vi.fn();
    render(<TagInput value={['Alpha']} onChange={onChange} suggestions={SUGGESTIONS} placeholder="Tags" />);
    fireEvent.focus(screen.getByRole('textbox'));
    fireEvent.mouseDown(screen.getByText('Bravo'));
    expect(onChange).toHaveBeenCalledWith(['Alpha', 'Bravo']);
  });

  it('a window scroll leaves the in-place menu open', () => {
    render(<TagInput value={[]} onChange={() => {}} suggestions={SUGGESTIONS} placeholder="Tags" />);
    fireEvent.focus(screen.getByPlaceholderText('Tags'));
    fireEvent.scroll(window);
    expect(screen.getByText('Alpha')).toBeTruthy();
  });
});
