// @vitest-environment jsdom
/** Settings › Devices › Barcode scanner card: a fast burst ending in Enter
 *  is a scan; it shows on the card and nowhere else. Human-speed typing is
 *  left alone. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ScannerCard from './ScannerCard';

/** A text field elsewhere on the page, with its own Enter handler (a
 *  stand-in for any kiosk scan action). */
function Field({ onEnter }: { onEnter: () => void }) {
  const [value, setValue] = useState('');
  return (
    <input aria-label="Other field" value={value} onChange={(e) => setValue(e.target.value)}
           onKeyDown={(e) => { if (e.key === 'Enter') onEnter(); }} />
  );
}

/** Type like a keyboard into `el`: keydown, then (unless prevented) the
 *  character lands in the field, as a browser would do. */
async function typeKeys(el: HTMLElement, keys: string[], gapMs: number) {
  for (const key of keys) {
    const allowed = fireEvent.keyDown(el, { key });
    if (allowed && key.length === 1 && el instanceof HTMLInputElement) {
      fireEvent.change(el, { target: { value: el.value + key } });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(gapMs); });
  }
}

const pill = () => document.querySelector('.device-card-head .chip') as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date('2026-10-17T15:00:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ScannerCard', () => {
  it('scanner_catches_a_fast_burst_ending_in_enter_and_shows_it', async () => {
    render(<ScannerCard />);
    expect(pill().textContent).toBe('Scan to test');
    expect(pill().className).toContain('c-slate');
    await typeKeys(document.body, [...'100212', 'Enter'], 10);
    expect(pill().textContent).toBe('Working');
    expect(pill().className).toContain('c-green');
    expect(screen.getByTestId('scanner-last').textContent).toBe('Last scan: 100212 · just now');
  });

  it('shift keys inside a burst do not break it', async () => {
    render(<ScannerCard />);
    await typeKeys(document.body, ['A', 'Shift', 'B', 'c', '1', 'Enter'], 8);
    expect(screen.getByTestId('scanner-last').textContent).toContain('ABc1');
  });

  it('a two-character scan is still a scan', async () => {
    render(<ScannerCard />);
    await typeKeys(document.body, ['4', '2', 'Enter'], 10);
    expect(screen.getByTestId('scanner-last').textContent).toBe('Last scan: 42 · just now');
  });

  it('key repeat from a held-down key is not a scan', async () => {
    const onEnter = vi.fn();
    render(<><Field onEnter={onEnter} /><ScannerCard /></>);
    const input = screen.getByLabelText('Other field') as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: 'a' });
    fireEvent.change(input, { target: { value: 'a' } });
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      if (fireEvent.keyDown(input, { key: 'a', repeat: true })) {
        fireEvent.change(input, { target: { value: `${input.value}a` } });
      }
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('aaaaaa');
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('scanner-last')).toBeNull();
  });

  it('slow_typing_in_a_field_is_not_captured', async () => {
    const onEnter = vi.fn();
    render(<><Field onEnter={onEnter} /><ScannerCard /></>);
    const input = screen.getByLabelText('Other field') as HTMLInputElement;
    input.focus();
    await typeKeys(input, [...'hello', 'Enter'], 150);
    expect(input.value).toBe('hello');
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(pill().textContent).toBe('Scan to test');
    expect(screen.queryByTestId('scanner-last')).toBeNull();
  });

  it('captured_scan_is_not_typed_into_the_focused_input', async () => {
    const onEnter = vi.fn();
    render(<><Field onEnter={onEnter} /><ScannerCard /></>);
    const input = screen.getByLabelText('Other field') as HTMLInputElement;
    input.focus();
    await typeKeys(input, [...'ab'], 200);   // a person typed "ab" first
    await typeKeys(input, [...'100212', 'Enter'], 10);
    expect(input.value).toBe('ab');
    expect(onEnter).not.toHaveBeenCalled();
    expect(screen.getByTestId('scanner-last').textContent).toContain('100212');
  });

  it('clear_resets_scanner_to_scan_to_test', async () => {
    render(<ScannerCard />);
    expect((screen.getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(true);
    await typeKeys(document.body, [...'4455', 'Enter'], 10);
    expect(pill().textContent).toBe('Working');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(pill().textContent).toBe('Scan to test');
    expect(screen.queryByTestId('scanner-last')).toBeNull();
  });

  it('stops listening when unmounted', async () => {
    const onEnter = vi.fn();
    const { unmount } = render(<><ScannerCard /></>);
    unmount();
    render(<Field onEnter={onEnter} />);
    const input = screen.getByLabelText('Other field') as HTMLInputElement;
    await typeKeys(input, [...'100212', 'Enter'], 10);
    expect(input.value).toBe('100212');
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('button_rows_use_the_bottom_pinned_actions_slot', () => {
    render(<ScannerCard />);
    const actions = document.querySelector('.device-card > .device-card-actions') as HTMLElement;
    expect(actions.parentElement?.lastElementChild).toBe(actions);
    expect(actions.contains(screen.getByRole('button', { name: 'Clear' }))).toBe(true);
  });
});
