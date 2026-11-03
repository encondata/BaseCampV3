// @vitest-environment jsdom
/**
 * PhotoPreview — the larger photo shown when hovering a person's avatar.
 * Covers: nothing without a photo, nothing before the 300 ms delay, the
 * card after it (whole image, 240 px, contain, name caption), closing on
 * leave / scroll / Escape / unmount, portaling into `.portal-shell`, the
 * placement rule (right of the avatar, flipped left near the right edge,
 * clamped vertically), and that wrapping changes neither layout nor
 * click behavior.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import PhotoPreview, { PREVIEW_DELAY_MS, previewPosition } from './PhotoPreview';

const SRC = 'https://files.example.test/ada.jpg';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function avatar() {
  return <span className="dir-avatar" data-testid="av">AL</span>;
}

function shell(ui: React.ReactElement) {
  return render(<div className="portal-shell" data-testid="shell">{ui}</div>);
}

const card = () => document.querySelector('.pp-card');

function hover(el: Element) {
  fireEvent.mouseOver(el);
  fireEvent.mouseEnter(el);
}

function stubRect(el: Element, r: Partial<DOMRect>) {
  const full = { x: r.left ?? 0, y: r.top ?? 0, width: 0, height: 0,
    left: 0, right: 0, top: 0, bottom: 0, toJSON: () => ({}), ...r } as DOMRect;
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(full);
}

it('renders its children unchanged, and never a preview, without a photo', () => {
  for (const src of [null, undefined, '']) {
    const { container, unmount } = shell(
      <PhotoPreview src={src} name="Ada Lovelace">{avatar()}</PhotoPreview>);
    expect(container.querySelector('.pp-wrap')).toBeNull();
    expect(container.querySelector('[data-testid="av"]')!.parentElement)
      .toBe(container.querySelector('.portal-shell'));
    hover(container.querySelector('[data-testid="av"]')!);
    act(() => { vi.advanceTimersByTime(PREVIEW_DELAY_MS * 2); });
    expect(card()).toBeNull();
    unmount();
  }
});

it('opens after 300 ms, not before', () => {
  expect(PREVIEW_DELAY_MS).toBe(300);
  const { getByTestId } = shell(
    <PhotoPreview src={SRC} name="Ada Lovelace">{avatar()}</PhotoPreview>);
  hover(getByTestId('av'));
  act(() => { vi.advanceTimersByTime(299); });
  expect(card()).toBeNull();
  act(() => { vi.advanceTimersByTime(1); });
  expect(card()).not.toBeNull();
});

it('shows the whole image at 240 px with the name underneath', () => {
  const { getByTestId } = shell(
    <PhotoPreview src={SRC} name="Ada Lovelace">{avatar()}</PhotoPreview>);
  hover(getByTestId('av'));
  act(() => { vi.advanceTimersByTime(PREVIEW_DELAY_MS); });
  const img = card()!.querySelector('img')!;
  expect(img.getAttribute('src')).toBe(SRC);
  expect(card()!.querySelector('.pp-name')!.textContent).toBe('Ada Lovelace');

  // jsdom applies no stylesheets from imports, so assert the rule itself.
  const css = readFileSync(join(__dirname, '../styles/photo-preview.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const imgRule = css.slice(css.indexOf('.pp-img'), css.indexOf('}', css.indexOf('.pp-img')));
  expect(imgRule).toMatch(/object-fit:\s*contain/);
  expect(imgRule).toMatch(/\bwidth:\s*240px/);
  expect(imgRule).toMatch(/\bheight:\s*240px/);
  expect(imgRule).toMatch(/border-radius:\s*9px/);
  expect(css).toMatch(/\.pp-card\s*\{[^}]*pointer-events:\s*none/);
  expect(css).toMatch(/\.pp-card\s*\{[^}]*border-radius:\s*14px/);
  expect(css).toMatch(/\.pp-wrap\s*\{\s*display:\s*contents/);
});

it('is portaled into .portal-shell so it keeps the theme tokens', () => {
  const { getByTestId } = shell(
    <PhotoPreview src={SRC} name="Ada Lovelace">{avatar()}</PhotoPreview>);
  hover(getByTestId('av'));
  act(() => { vi.advanceTimersByTime(PREVIEW_DELAY_MS); });
  expect(card()!.parentElement).toBe(getByTestId('shell'));
  expect(card()!.closest('.pp-wrap')).toBeNull();
});

it('falls back to document.body outside a .portal-shell', () => {
  const { getByTestId } = render(
    <PhotoPreview src={SRC} name="Ada Lovelace">{avatar()}</PhotoPreview>);
  hover(getByTestId('av'));
  act(() => { vi.advanceTimersByTime(PREVIEW_DELAY_MS); });
  expect(card()!.parentElement).toBe(document.body);
});

it('does not open if the pointer leaves before the delay', () => {
  const { getByTestId } = shell(
    <PhotoPreview src={SRC} name="Ada Lovelace">{avatar()}</PhotoPreview>);
  hover(getByTestId('av'));
  act(() => { vi.advanceTimersByTime(200); });
  fireEvent.mouseOut(getByTestId('av'), { relatedTarget: document.body });
  fireEvent.mouseLeave(getByTestId('av'));
  act(() => { vi.advanceTimersByTime(500); });
  expect(card()).toBeNull();
});

function open() {
  const utils = shell(
    <PhotoPreview src={SRC} name="Ada Lovelace">{avatar()}</PhotoPreview>);
  hover(utils.getByTestId('av'));
  act(() => { vi.advanceTimersByTime(PREVIEW_DELAY_MS); });
  expect(card()).not.toBeNull();
  return utils;
}

it('closes on mouse leave', () => {
  const { getByTestId } = open();
  fireEvent.mouseOut(getByTestId('av'), { relatedTarget: document.body });
  fireEvent.mouseLeave(getByTestId('av'));
  expect(card()).toBeNull();
});

it('closes on any scroll, including a nested scroller (capture)', () => {
  const { getByTestId } = open();
  fireEvent.scroll(getByTestId('shell'));
  expect(card()).toBeNull();
});

it('closes on Escape', () => {
  open();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(card()).toBeNull();
});

it('ignores other keys', () => {
  open();
  fireEvent.keyDown(document.body, { key: 'a' });
  expect(card()).not.toBeNull();
});

it('closes when the avatar unmounts', () => {
  const { unmount } = open();
  unmount();
  expect(card()).toBeNull();
});

it('closes when the photo goes away while open', () => {
  const { getByTestId, rerender } = open();
  rerender(<div className="portal-shell">
    <PhotoPreview src={null} name="Ada Lovelace">{avatar()}</PhotoPreview></div>);
  expect(card()).toBeNull();
  expect(getByTestId('av')).toBeTruthy();
});

it('does not change click behavior', () => {
  const onClick = vi.fn();
  const onRow = vi.fn();
  const { getByTestId } = shell(
    <div onClick={onRow}>
      <PhotoPreview src={SRC} name="Ada Lovelace">
        <button data-testid="av" onClick={onClick}>AL</button>
      </PhotoPreview>
    </div>);
  hover(getByTestId('av'));
  act(() => { vi.advanceTimersByTime(PREVIEW_DELAY_MS); });
  fireEvent.click(getByTestId('av'));
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(onRow).toHaveBeenCalledTimes(1);
});

it('is layout-neutral: the wrapper has no box and the avatar stays a direct flex item', () => {
  const { getByTestId } = shell(
    <div style={{ display: 'flex' }}>
      <PhotoPreview src={SRC} name="Ada Lovelace">{avatar()}</PhotoPreview>
    </div>);
  const wrap = getByTestId('av').parentElement!;
  expect(wrap.className).toBe('pp-wrap');
  // The stylesheet gives the wrapper `display: contents` (asserted above);
  // the element it wraps is the first element child it anchors on.
  expect(wrap.children).toHaveLength(1);
  expect(wrap.firstElementChild).toBe(getByTestId('av'));
});

it('anchors on the avatar, not the wrapper, and opens to its right with a 10 px gap', () => {
  const { getByTestId } = shell(
    <PhotoPreview src={SRC} name="Ada Lovelace">{avatar()}</PhotoPreview>);
  const av = getByTestId('av');
  stubRect(av, { left: 100, right: 140, top: 300, bottom: 340, width: 40, height: 40 });
  hover(av);
  act(() => { vi.advanceTimersByTime(PREVIEW_DELAY_MS); });
  const el = card() as HTMLElement;
  expect(el.style.left).toBe('150px');
  // Vertically centered on the avatar (center 320) using the estimated height.
  expect(parseFloat(el.style.top)).toBeCloseTo(320 - 282 / 2, 5);
});

it('flips to the left of the avatar near the right edge', () => {
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  const { getByTestId } = shell(
    <PhotoPreview src={SRC} name="Ada Lovelace">{avatar()}</PhotoPreview>);
  const av = getByTestId('av');
  stubRect(av, { left: 960, right: 1000, top: 300, bottom: 340, width: 40, height: 40 });
  hover(av);
  act(() => { vi.advanceTimersByTime(PREVIEW_DELAY_MS); });
  const left = parseFloat((card() as HTMLElement).style.left);
  expect(left + 254).toBeCloseTo(960 - 10, 5);
});

it('uses the real card size once measured', () => {
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const small = this.classList.contains('pp-card');
    const av = this.getAttribute('data-testid') === 'av';
    const r = av ? { left: 800, right: 840, top: 100, bottom: 140 }
      : { left: 0, right: small ? 120 : 0, top: 0, bottom: small ? 140 : 0 };
    return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top,
      toJSON: () => ({}) } as DOMRect;
  });
  const { getByTestId } = shell(
    <PhotoPreview src={SRC} name="Ada Lovelace">{avatar()}</PhotoPreview>);
  hover(getByTestId('av'));
  act(() => { vi.advanceTimersByTime(PREVIEW_DELAY_MS); });
  const el = card() as HTMLElement;
  // A 120 px wide card fits to the right (850 + 120 < 1016), where the
  // 254 px estimate alone would also fit; the height is the measured 140.
  expect(el.style.left).toBe('850px');
  expect(parseFloat(el.style.top)).toBeCloseTo(120 - 70, 5);
});

it('previewPosition clamps vertically and horizontally inside the viewport', () => {
  const a = { left: 10, right: 50, top: 5, bottom: 45 };
  expect(previewPosition(a, 1000, 800, 254, 282).top).toBe(8);          // top clamp
  const low = { left: 10, right: 50, top: 780, bottom: 800 };
  expect(previewPosition(low, 1000, 800, 254, 282).top).toBe(800 - 282 - 8); // bottom clamp
  const far = { left: 20, right: 60, top: 100, bottom: 140 };
  expect(previewPosition(far, 200, 800, 254, 282).left).toBe(8);        // narrow viewport
});
