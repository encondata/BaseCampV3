// @vitest-environment jsdom
/**
 * components/plans/TaskColorPicker.tsx: the one popover that picks a task's
 * bar color, shared by the toolbar's Task color, the sheet's Color cell and
 * Task Information — the palette's swatches by name, No color, and Custom…
 * with the initiative color's ColorWheel. Portaled into the shell; Escape
 * closes it and is marked handled, so nothing behind it takes that key.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TASK_COLORS } from '../../lib/plans/taskColor';
import TaskColorPicker from './TaskColorPicker';

afterEach(cleanup);

function setup(value: string | null | undefined) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const { container } = render(
    <div className="portal-shell">
      <button type="button">anchor</button>
    </div>,
  );
  const anchor = screen.getByRole('button', { name: 'anchor' });
  const shell = container.querySelector('.portal-shell') as HTMLElement;
  const view = render(<TaskColorPicker anchor={anchor} value={value} onPick={onPick} onClose={onClose} />,
    { container: document.body.appendChild(document.createElement('div')) });
  const picker = screen.getByRole('dialog', { name: 'Task color' });
  return { onPick, onClose, picker, shell, anchor, view };
}

describe('TaskColorPicker', () => {
  it('offers the palette by name, No color and Custom…, portaled into the shell', () => {
    const { picker, shell } = setup(null);
    expect(picker.parentElement).toBe(shell);
    const swatches = [...picker.querySelectorAll<HTMLButtonElement>('button.pln-hue')];
    expect(swatches.map((b) => b.getAttribute('aria-label'))).toEqual(TASK_COLORS.map((c) => c.label));
    for (const b of swatches) expect(b.style.background, b.getAttribute('aria-label') ?? '').not.toBe('');
    expect(within(picker).getByRole('button', { name: 'No color' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(picker).getByRole('button', { name: 'Custom…' })).toBeTruthy();
  });

  it('a swatch picks its color; No color picks none', () => {
    const { picker, onPick } = setup('#1668a7');
    const blue = within(picker).getByRole('button', { name: 'Blue' });
    expect(blue.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(blue);           // opens on the color it has
    fireEvent.click(within(picker).getByRole('button', { name: 'Green' }));
    expect(onPick).toHaveBeenLastCalledWith('#178a4c');
    fireEvent.click(within(picker).getByRole('button', { name: 'No color' }));
    expect(onPick).toHaveBeenLastCalledWith(null);
  });

  it('mixed (undefined): nothing shows as picked', () => {
    const { picker } = setup(undefined);
    expect(within(picker).queryAllByRole('button', { pressed: true })).toEqual([]);
  });

  it('Custom… opens the color wheel on the color it has; Apply picks what it shows', () => {
    const { picker, onPick } = setup('#e91e63');
    fireEvent.click(within(picker).getByRole('button', { name: 'Custom…' }));
    const hex = within(picker).getByRole('textbox', { name: 'Hex' }) as HTMLInputElement;
    expect(hex.value).toBe('#e91e63');
    fireEvent.change(hex, { target: { value: '#00897B' } });
    fireEvent.blur(hex);
    fireEvent.click(within(picker).getByRole('button', { name: 'Apply' }));
    expect(onPick).toHaveBeenLastCalledWith('#00897b');
    // Back returns to the swatches without picking
    fireEvent.click(within(picker).getByRole('button', { name: 'Back' }));
    expect(within(picker).getByRole('button', { name: 'Blue' })).toBeTruthy();
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('Escape closes it and is marked handled; a press outside closes it too', () => {
    const { picker, onClose, onPick } = setup(null);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { within(picker).getByRole('button', { name: 'Blue' }).dispatchEvent(esc); });
    expect(esc.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(within(picker).getByRole('button', { name: 'Red' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('focus moving outside closes it; within it, or dropped to nowhere, does not', () => {
    const { picker, onClose, anchor } = setup(null);
    const blue = within(picker).getByRole('button', { name: 'Blue' });
    fireEvent.blur(blue, { relatedTarget: within(picker).getByRole('button', { name: 'Red' }) });
    fireEvent.blur(blue, { relatedTarget: null });
    fireEvent.blur(blue, { relatedTarget: anchor });
    expect(onClose).not.toHaveBeenCalled();
    const outside = document.body.appendChild(document.createElement('button'));
    fireEvent.blur(blue, { relatedTarget: outside });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape in Custom… goes back to the swatches first', () => {
    const { picker, onClose } = setup(null);
    fireEvent.click(within(picker).getByRole('button', { name: 'Custom…' }));
    fireEvent.keyDown(within(picker).getByRole('slider', { name: 'Hue' }), { key: 'Escape' });
    expect(within(picker).getByRole('button', { name: 'Blue' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
