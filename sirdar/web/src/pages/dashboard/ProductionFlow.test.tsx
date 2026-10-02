// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const g = vi.hoisted(() => {
  const revert = vi.fn();
  return {
    revert,
    gsap: {
      registerPlugin: vi.fn(),
      to: vi.fn(() => ({ progress: vi.fn() })),
      set: vi.fn(),
      context: vi.fn((fn: () => void) => { fn(); return { revert }; }),
    },
  };
});
vi.mock('gsap', () => ({ gsap: g.gsap, default: g.gsap }));
vi.mock('gsap/MotionPathPlugin', () => ({ MotionPathPlugin: {} }));

import ProductionFlow from './ProductionFlow';
import { DEMO, EMPTY } from './testData';

const proto = SVGElement.prototype as unknown as Record<string, unknown>;
beforeAll(() => { proto.getTotalLength = () => 100; });
afterAll(() => { delete proto.getTotalLength; });
beforeEach(() => { Object.values(g.gsap).forEach((f) => f.mockClear()); g.revert.mockClear(); });
afterEach(cleanup);

it('animates 12 glowing dots along the active path when motion is on', () => {
  const { container, unmount } = render(<ProductionFlow production={DEMO.production} motion />);
  expect(container.querySelectorAll('.sd-flow-dot')).toHaveLength(12);
  expect(g.gsap.to).toHaveBeenCalledTimes(12);
  const vars = (g.gsap.to.mock.calls[0] as unknown[])[1] as { duration: number; repeat: number; motionPath: unknown };
  expect(vars.duration).toBe(2.5);
  expect(vars.repeat).toBe(-1);
  expect(vars.motionPath).toBeTruthy();
  unmount();
  expect(g.revert).toHaveBeenCalled();
});

it('reduced motion: static dots and no animation', () => {
  const { container } = render(<ProductionFlow production={DEMO.production} motion={false} />);
  expect(container.querySelectorAll('.sd-flow-dot')).toHaveLength(12);
  expect(g.gsap.to).not.toHaveBeenCalled();
});

it('the portal motion switch (data-motion="off") also stops the animation', () => {
  const shell = document.createElement('div');
  shell.className = 'portal-shell';
  shell.setAttribute('data-motion', 'off');
  document.body.appendChild(shell);
  render(<ProductionFlow production={DEMO.production} motion />, { container: shell });
  expect(g.gsap.to).not.toHaveBeenCalled();
  shell.remove();
});

it('inactive production: dashed gray curves and no dots', () => {
  const { container } = render(<ProductionFlow production={EMPTY.production} motion />);
  expect(container.querySelectorAll('.sd-flow-dot')).toHaveLength(0);
  expect(g.gsap.to).not.toHaveBeenCalled();
  const curves = container.querySelectorAll('.sd-flow-curve');
  expect(curves).toHaveLength(2);
  curves.forEach((c) => expect(c.getAttribute('class')).toMatch(/is-idle/));
});

it('active production: solid blue curve to the active slot, dashed to standby', () => {
  const { container } = render(<ProductionFlow production={DEMO.production} motion={false} />);
  const [blue, green] = Array.from(container.querySelectorAll('.sd-flow-curve'));
  expect(blue.getAttribute('class')).toMatch(/is-live/);
  expect(green.getAttribute('class')).toMatch(/is-idle/);
});

it('cleanup clears the inline opacity written by onUpdate', () => {
  const { container, unmount } = render(<ProductionFlow production={DEMO.production} motion />);
  const vars = (g.gsap.to.mock.calls[0] as unknown[])[1] as { onUpdate: (this: unknown) => void };
  vars.onUpdate.call({ progress: () => 0.5 });
  const dot = container.querySelector('.sd-flow-dot') as SVGCircleElement;
  expect(dot.style.opacity).toBe('1');
  unmount();
  expect(dot.style.opacity).toBe('');
});

it('toggling prefers-reduced-motion re-runs the effect and removes its listener', () => {
  let listener: (() => void) | undefined;
  const mq = {
    matches: false,
    addEventListener: vi.fn((_: string, fn: () => void) => { listener = fn; }),
    removeEventListener: vi.fn(),
  };
  const original = window.matchMedia;
  window.matchMedia = (() => mq) as unknown as typeof window.matchMedia;
  try {
    const { unmount } = render(<ProductionFlow production={DEMO.production} motion />);
    expect(g.gsap.to).toHaveBeenCalledTimes(12);
    g.revert.mockClear();
    mq.matches = true;
    act(() => listener!());
    expect(g.revert).toHaveBeenCalled();
    expect(g.gsap.to).toHaveBeenCalledTimes(12);
    mq.matches = false;
    act(() => listener!());
    expect(g.gsap.to).toHaveBeenCalledTimes(24);
    unmount();
    expect(mq.removeEventListener).toHaveBeenCalledWith('change', listener);
  } finally {
    window.matchMedia = original;
  }
});
