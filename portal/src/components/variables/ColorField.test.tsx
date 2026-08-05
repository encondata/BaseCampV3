// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FormEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ColorField from './ColorField';

// RTL's auto-cleanup only self-registers when `afterEach` is a real global
// (vitest globals: true); this repo doesn't set that (see AppShell.test.tsx,
// SiteEditModal.test.tsx), so without this each `it` below leaks its render
// into the next and getByLabelText/getByRole start matching more than one.
afterEach(cleanup);

describe('ColorField', () => {
  it('emits the preset hex when a swatch is clicked', () => {
    const onChange = vi.fn();
    render(<ColorField value="#178a4c" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /red/i }));
    expect(onChange).toHaveBeenCalledWith('#c03540');
  });

  it('normalises a pasted hex rather than rejecting it', () => {
    const onChange = vi.fn();
    render(<ColorField value="#178a4c" onChange={onChange} />);
    const text = screen.getByLabelText(/hex/i);
    fireEvent.change(text, { target: { value: '#AABBCC' } });
    fireEvent.blur(text);
    expect(onChange).toHaveBeenCalledWith('#aabbcc');
  });

  it('does not emit junk', () => {
    const onChange = vi.fn();
    render(<ColorField value="#178a4c" onChange={onChange} />);
    const text = screen.getByLabelText(/hex/i);
    fireEvent.change(text, { target: { value: 'not-a-colour' } });
    fireEvent.blur(text);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows an inline hint instead of silently discarding junk', () => {
    const onChange = vi.fn();
    render(<ColorField value="#178a4c" onChange={onChange} />);
    const text = screen.getByLabelText(/hex/i);
    expect(screen.queryByText(/not a valid hex colour/i)).toBeNull();
    fireEvent.change(text, { target: { value: '#gg0000' } });
    fireEvent.blur(text);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/not a valid hex colour/i)).toBeDefined();
  });

  it('commits on Enter, not just on blur', () => {
    // Enter triggers implicit form submission in these modals (the only
    // button is type="submit"), which never fires blur — this is what
    // would silently save the OLD colour if Enter weren't intercepted.
    const onChange = vi.fn();
    const onSubmit = vi.fn((e: FormEvent<HTMLFormElement>) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <ColorField value="#178a4c" onChange={onChange} />
      </form>,
    );
    const text = screen.getByLabelText(/hex/i);
    fireEvent.change(text, { target: { value: '#ff0000' } });
    fireEvent.keyDown(text, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('#ff0000');
    // preventDefault on the keydown is what stops the implicit submit —
    // if Enter fell through, the form's own submit handler would also fire.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('surfaces the same invalid hint on an Enter commit', () => {
    const onChange = vi.fn();
    render(<ColorField value="#178a4c" onChange={onChange} />);
    const text = screen.getByLabelText(/hex/i);
    fireEvent.change(text, { target: { value: '#gg0000' } });
    fireEvent.keyDown(text, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/not a valid hex colour/i)).toBeDefined();
  });

  it('chip shape (the default) sets --chip, not --lvl', () => {
    const { container } = render(<ColorField value="#178a4c" onChange={vi.fn()} />);
    const chip = container.querySelector('.chip.custom') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.style.getPropertyValue('--chip')).toBe('#178a4c');
    // and NOT --lvl: the two clamps are opposites, so a chip carrying a badge's
    // property invites the reader to think they're interchangeable
    expect(chip.style.getPropertyValue('--lvl')).toBe('');
    expect(container.querySelector('.lvl-badge')).toBeNull();
  });

  it('badge shape sets --lvl and renders .lvl-badge, not .chip', () => {
    const { container } = render(
      <ColorField value="#6d4fc4" onChange={vi.fn()} shape="badge" sample="L3" />,
    );
    const badge = container.querySelector('.lvl-badge b') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.style.getPropertyValue('--lvl')).toBe('#6d4fc4');
    expect(badge.style.getPropertyValue('--chip')).toBe('');
    expect(badge.textContent).toBe('L3');
    expect(container.querySelector('.chip.custom')).toBeNull();
  });

  it('badge shape falls back to a neutral sample when none is given', () => {
    const { container } = render(
      <ColorField value="#6d4fc4" onChange={vi.fn()} shape="badge" />,
    );
    const badge = container.querySelector('.lvl-badge b') as HTMLElement;
    expect(badge.textContent).toBe('—');
  });
});
