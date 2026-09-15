// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FormEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hexToHsl, hslToHex } from '../lib/variables';
import ColorWheel from './ColorWheel';

// RTL's auto-cleanup only self-registers when `afterEach` is a real global
// (vitest globals: true); this repo doesn't set that — same note as
// ColorField.test.tsx.
afterEach(cleanup);

// The twelve initiative palette hues (design doc). One stored hex has to
// survive a trip through HSL and back, because the wheel only ever edits
// the H and L of whatever the parent handed it.
const PALETTE = [
  '#1668a7', '#0f7c86', '#178a4c', '#5d8a17', '#a36207', '#c05a1f',
  '#c03540', '#b3316d', '#8b3fb8', '#6d4fc4', '#3f63c4', '#51606f',
];

const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

describe('hexToHsl / hslToHex', () => {
  it('round-trips every palette color within one unit per channel', () => {
    for (const hex of PALETTE) {
      const hsl = hexToHsl(hex);
      expect(hsl).not.toBeNull();
      const back = hslToHex(hsl!);
      expect(back).toMatch(/^#[0-9a-f]{6}$/);
      const [r0, g0, b0] = rgb(hex);
      const [r1, g1, b1] = rgb(back);
      expect(Math.abs(r1 - r0)).toBeLessThanOrEqual(1);
      expect(Math.abs(g1 - g0)).toBeLessThanOrEqual(1);
      expect(Math.abs(b1 - b0)).toBeLessThanOrEqual(1);
    }
  });

  it('refuses junk rather than guessing a hue', () => {
    expect(hexToHsl('not-a-color')).toBeNull();
    expect(hexToHsl('#12')).toBeNull();
  });

  it('accepts the short form and keeps hue in degrees, s/l in percent', () => {
    const hsl = hexToHsl('#f00');
    expect(hsl).not.toBeNull();
    expect(hsl!.h).toBeCloseTo(0, 5);
    expect(hsl!.s).toBeCloseTo(100, 5);
    expect(hsl!.l).toBeCloseTo(50, 5);
    expect(hslToHex({ h: 0, s: 100, l: 50 })).toBe('#ff0000');
  });
});

describe('ColorWheel', () => {
  it('renders the hue handle as a slider carrying the value hue', () => {
    render(<ColorWheel value="#1668a7" onChange={vi.fn()} />);
    const handle = screen.getByRole('slider', { name: /hue/i });
    const hue = hexToHsl('#1668a7')!.h;
    expect(handle.getAttribute('aria-valuenow')).toBe(String(Math.round(hue)));
    expect(handle.getAttribute('aria-valuemin')).toBe('0');
    expect(handle.getAttribute('aria-valuemax')).toBe('360');
  });

  it('ArrowRight steps the hue one degree and emits a new hex', () => {
    const onChange = vi.fn();
    render(<ColorWheel value="#1668a7" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('slider', { name: /hue/i }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as string;
    expect(next).toMatch(/^#[0-9a-f]{6}$/);
    expect(next).not.toBe('#1668a7');
    const before = hexToHsl('#1668a7')!;
    const after = hexToHsl(next)!;
    expect(after.h - before.h).toBeGreaterThan(0.2);
    expect(after.h - before.h).toBeLessThan(2.5);
  });

  it('ArrowLeft steps back, and Shift accelerates', () => {
    const onChange = vi.fn();
    render(<ColorWheel value="#1668a7" onChange={onChange} />);
    const handle = screen.getByRole('slider', { name: /hue/i });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    const before = hexToHsl('#1668a7')!;
    const back = hexToHsl(onChange.mock.calls[0][0] as string)!;
    expect(back.h).toBeLessThan(before.h);

    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    const fast = hexToHsl(onChange.mock.calls[1][0] as string)!;
    expect(fast.h - before.h).toBeGreaterThan(5);
  });

  it('the lightness slider changes the hex without moving the hue', () => {
    const onChange = vi.fn();
    render(<ColorWheel value="#1668a7" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/lightness/i), { target: { value: '70' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = hexToHsl(onChange.mock.calls[0][0] as string)!;
    expect(next.l).toBeGreaterThan(68);
    expect(next.l).toBeLessThan(72);
    expect(Math.abs(next.h - hexToHsl('#1668a7')!.h)).toBeLessThan(2);
  });

  it('commits a typed hex on blur, normalized', () => {
    const onChange = vi.fn();
    render(<ColorWheel value="#1668a7" onChange={onChange} />);
    const text = screen.getByLabelText(/hex/i);
    fireEvent.change(text, { target: { value: '#ABC' } });
    fireEvent.blur(text);
    expect(onChange).toHaveBeenCalledWith('#aabbcc');
  });

  it('commits on Enter without submitting the enclosing form', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn((e: FormEvent<HTMLFormElement>) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <ColorWheel value="#1668a7" onChange={onChange} />
      </form>,
    );
    const text = screen.getByLabelText(/hex/i);
    fireEvent.change(text, { target: { value: '#ff0000' } });
    fireEvent.keyDown(text, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('#ff0000');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows the invalid hint for junk and does not emit', () => {
    const onChange = vi.fn();
    render(<ColorWheel value="#1668a7" onChange={onChange} />);
    const text = screen.getByLabelText(/hex/i);
    expect(screen.queryByText(/not a valid hex color/i)).toBeNull();
    fireEvent.change(text, { target: { value: '#gg0000' } });
    fireEvent.blur(text);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/not a valid hex color/i)).toBeDefined();
  });

  it('previews the real chip shape in the picked color', () => {
    const { container } = render(<ColorWheel value="#8b3fb8" onChange={vi.fn()} />);
    const chip = container.querySelector('.chip.custom') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.style.getPropertyValue('--chip')).toBe('#8b3fb8');
  });

  it('disabled takes the handle out of the tab order and freezes the controls', () => {
    const onChange = vi.fn();
    render(<ColorWheel value="#1668a7" onChange={onChange} disabled />);
    const handle = screen.getByRole('slider', { name: /hue/i });
    expect(handle.getAttribute('tabindex')).toBe('-1');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/hex/i) as HTMLInputElement).disabled).toBe(true);
  });
});
