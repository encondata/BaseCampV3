// @vitest-environment jsdom
/**
 * TagInput.tsx: the suggestion menu inside a `.modal-card`. The card's
 * overflow-y:auto would clip an in-place menu, so TagInput portals it to
 * document.body there (fixed positioning, placed by the shared
 * useMenuPlacement hook). Outside a card the menu stays in place, as before.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import TagInput from './TagInput';

const SUGGESTIONS = ['Alpha', 'Bravo'];

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

  it('adds a suggestion by mousedown (the outside-click guard sees the portaled menu as inside)', () => {
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

  it('a window scroll or resize closes it; scrolling the menu itself does not', () => {
    renderInCard();
    const input = screen.getByPlaceholderText('Tags');
    fireEvent.focus(input);
    fireEvent.scroll(screen.getByText('Alpha').closest('.combo-menu')!);
    expect(screen.getByText('Alpha')).toBeTruthy();
    fireEvent.scroll(window);
    expect(screen.queryByText('Alpha')).toBeNull();

    fireEvent.change(input, { target: { value: 'a' } });
    expect(screen.getByText('Alpha')).toBeTruthy();
    fireEvent(window, new Event('resize'));
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('scrolling the card closes it', () => {
    renderInCard();
    fireEvent.focus(screen.getByPlaceholderText('Tags'));
    fireEvent.scroll(screen.getByTestId('card'));
    expect(screen.queryByText('Alpha')).toBeNull();
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
