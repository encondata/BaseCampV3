// @vitest-environment jsdom
/**
 * Tip: a styled hover tip for one trigger. It shows 350 ms into a hover,
 * at once on keyboard focus (never on the focus a mouse click gives),
 * hides on leave, blur, Escape, a pointer press or a scroll, portals into
 * the .portal-shell below its trigger (above when there's no room), works
 * on a disabled trigger, wires aria-describedby while it shows, and only
 * one shows at a time.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Tip, { placeTip, TIP_DELAY_MS } from './Tip';

function renderTips() {
  return render(
    <div className="portal-shell">
      <Tip label="Zoom out" keys="⌘-">
        <button type="button" aria-label="Zoom out" title="native">−</button>
      </Tip>
      <Tip label="Clone to a new template" note="Save your changes first.">
        <button type="button" disabled>Clone</button>
      </Tip>
      <Tip label="Delete" keys="⌦ / ⌫">
        <button type="button">Delete</button>
      </Tip>
    </div>,
  );
}

const zoomOut = () => screen.getByRole('button', { name: 'Zoom out' });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('hover', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('shows after the delay, portaled into the shell, with the label and keycaps', () => {
    const { container } = renderTips();
    fireEvent.pointerEnter(zoomOut());
    act(() => { vi.advanceTimersByTime(TIP_DELAY_MS - 1); });
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('Zoom out⌘-');
    expect(tip.querySelector('kbd')?.textContent).toBe('⌘-');
    // portaled: in the shell (its theme tokens), not inside the trigger
    expect(tip.parentElement).toBe(container.querySelector('.portal-shell'));
    expect(zoomOut().contains(tip)).toBe(false);
  });

  it('a leave before the delay shows nothing; a leave after hides it', () => {
    renderTips();
    fireEvent.pointerEnter(zoomOut());
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.pointerLeave(zoomOut());
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.pointerEnter(zoomOut());
    act(() => { vi.advanceTimersByTime(TIP_DELAY_MS); });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.pointerLeave(zoomOut());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a pointer press or a scroll hides it', () => {
    renderTips();
    fireEvent.pointerEnter(zoomOut());
    act(() => { vi.advanceTimersByTime(TIP_DELAY_MS); });
    fireEvent.pointerDown(zoomOut());
    expect(screen.queryByRole('tooltip')).toBeNull();
    // a press before the delay cancels it too
    fireEvent.pointerEnter(zoomOut());
    fireEvent.pointerDown(document.body);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.pointerLeave(zoomOut());
    fireEvent.pointerEnter(zoomOut());
    act(() => { vi.advanceTimersByTime(TIP_DELAY_MS); });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.scroll(window);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a disabled trigger still shows its tip, with the second line', () => {
    renderTips();
    const clone = screen.getByRole('button', { name: 'Clone' });
    expect((clone as HTMLButtonElement).disabled).toBe(true);
    fireEvent.pointerEnter(clone.parentElement as HTMLElement);   // the wrapper takes the pointer
    act(() => { vi.advanceTimersByTime(TIP_DELAY_MS); });
    const tip = screen.getByRole('tooltip');
    expect(tip.querySelector('.tip-label')?.textContent).toBe('Clone to a new template');
    expect(tip.querySelector('.tip-note')?.textContent).toBe('Save your changes first.');
  });

  it('several bindings are one keycap each', () => {
    renderTips();
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Delete' }));
    act(() => { vi.advanceTimersByTime(TIP_DELAY_MS); });
    expect([...screen.getByRole('tooltip').querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['⌦', '⌫']);
  });
});

describe('focus', () => {
  it('keyboard focus shows it at once; Escape and blur hide it', async () => {
    const user = userEvent.setup();
    renderTips();
    await user.tab();
    expect(document.activeElement).toBe(zoomOut());
    expect(screen.getByRole('tooltip').textContent).toBe('Zoom out⌘-');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.tab();                               // on to Delete (Clone is disabled)
    expect(screen.getByRole('tooltip').textContent).toMatch(/^Delete/);
    act(() => { (document.activeElement as HTMLElement).blur(); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('the focus a mouse click gives shows nothing', () => {
    // fake timers, so fireEvent: user-event's waits never resolve under them
    vi.useFakeTimers();
    renderTips();
    fireEvent.pointerEnter(zoomOut());
    fireEvent.pointerDown(zoomOut());
    fireEvent.mouseDown(zoomOut());
    act(() => { zoomOut().focus(); });
    fireEvent.click(zoomOut());
    expect(document.activeElement).toBe(zoomOut());
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

it('wires aria-describedby only while it shows, and drops the native title', async () => {
  const user = userEvent.setup();
  renderTips();
  expect(zoomOut().getAttribute('title')).toBeNull();
  expect(zoomOut().getAttribute('aria-describedby')).toBeNull();
  await user.tab();
  const tip = screen.getByRole('tooltip');
  expect(tip.id).toBeTruthy();
  expect(zoomOut().getAttribute('aria-describedby')).toBe(tip.id);
  await user.keyboard('{Escape}');
  expect(zoomOut().getAttribute('aria-describedby')).toBeNull();
});

it('shows one tip at a time', () => {
  vi.useFakeTimers();
  renderTips();
  fireEvent.pointerEnter(screen.getByRole('button', { name: 'Delete' }));
  act(() => { vi.advanceTimersByTime(TIP_DELAY_MS); });
  expect(screen.getByRole('tooltip').textContent).toMatch(/^Delete/);
  fireEvent.keyDown(document.body, { key: 'Tab' });  // a keyboard focus on Zoom out
  act(() => { zoomOut().focus(); });
  expect(screen.getAllByRole('tooltip')).toHaveLength(1);
  expect(screen.getByRole('tooltip').textContent).toBe('Zoom out⌘-');
});

describe('placement', () => {
  const VIEW = { width: 1000, height: 800 };
  const rect = (left: number, top: number, width = 30, height = 30) => (
    { left, top, width, height, right: left + width, bottom: top + height });

  it('sits below the trigger, centered', () => {
    expect(placeTip(rect(500, 100), { width: 120, height: 40 }, VIEW))
      .toEqual({ left: 455, top: 136, placement: 'below' });
  });

  it('flips above when there is no room below', () => {
    expect(placeTip(rect(500, 740), { width: 120, height: 40 }, VIEW))
      .toEqual({ left: 455, top: 694, placement: 'above' });
  });

  it('stays in the viewport horizontally', () => {
    expect(placeTip(rect(0, 100), { width: 120, height: 40 }, VIEW).left).toBe(8);
    expect(placeTip(rect(980, 100), { width: 120, height: 40 }, VIEW).left).toBe(1000 - 8 - 120);
  });

  it('a tip near the bottom of the window renders above its trigger', () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.classList.contains('tip')) return { ...rect(0, 0, 120, 40), x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      if (this.classList.contains('tip-trigger')) return { ...rect(500, 750), x: 500, y: 750, toJSON: () => ({}) } as DOMRect;
      return { ...rect(0, 0, 0, 0), x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    renderTips();
    fireEvent.pointerEnter(zoomOut());
    act(() => { vi.advanceTimersByTime(TIP_DELAY_MS); });
    const tip = screen.getByRole('tooltip');
    expect(tip.getAttribute('data-placement')).toBe('above');
    expect(tip.style.top).toBe('704px');
    expect(tip.style.left).toBe('455px');
    expect(tip.style.visibility).toBe('');
  });
});

describe('the trigger at work', () => {
  it('Enter or Space on the trigger hides its tip', async () => {
    const user = userEvent.setup();
    renderTips();
    await user.tab();
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(zoomOut(), { key: 'Enter' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    // shown again by the next keyboard focus, then Space
    await user.tab();
    await user.tab({ shift: true });
    expect(screen.getByRole('tooltip').textContent).toBe('Zoom out⌘-');
    fireEvent.keyDown(zoomOut(), { key: ' ' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a trigger turned off while its tip shows hides the tip', () => {
    vi.useFakeTimers();
    const view = (disabled: boolean) => (
      <div className="portal-shell">
        <Tip label="Save" keys="⌘S" note={disabled ? 'Saving…' : null}>
          <button type="button" disabled={disabled}>Save</button>
        </Tip>
      </div>
    );
    const { rerender } = render(view(false));
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.pointerEnter(save);
    act(() => { vi.advanceTimersByTime(TIP_DELAY_MS); });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    rerender(view(true));
    expect(screen.queryByRole('tooltip')).toBeNull();
    // a hover on the disabled trigger still shows its tip, with the reason
    fireEvent.pointerLeave(save.parentElement as HTMLElement);
    fireEvent.pointerEnter(save.parentElement as HTMLElement);
    act(() => { vi.advanceTimersByTime(TIP_DELAY_MS); });
    expect(screen.getByRole('tooltip').querySelector('.tip-note')?.textContent).toBe('Saving…');
    // and turning it back on leaves the tip up
    rerender(view(false));
    expect(screen.getByRole('tooltip')).toBeTruthy();
  });
});
