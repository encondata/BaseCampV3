// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
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

import EnvironmentFlow from './EnvironmentFlow';
import { CLOUD, LAN_CARD, PLACEHOLDER_PROD, PROD_CARD } from './testData';

const proto = SVGElement.prototype as unknown as Record<string, unknown>;
beforeAll(() => { proto.getTotalLength = () => 100; });
afterAll(() => { delete proto.getTotalLength; });
beforeEach(() => { Object.values(g.gsap).forEach((f) => f.mockClear()); g.revert.mockClear(); });
afterEach(cleanup);

it('animates 12 glowing dots along the active path when motion is on', () => {
  const { container, unmount } = render(<EnvironmentFlow flow={PROD_CARD.flow} motion />);
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
  const { container } = render(<EnvironmentFlow flow={PROD_CARD.flow} motion={false} />);
  expect(container.querySelectorAll('.sd-flow-dot')).toHaveLength(12);
  expect(g.gsap.to).not.toHaveBeenCalled();
});

it('the portal motion switch (data-motion="off") also stops the animation', () => {
  const shell = document.createElement('div');
  shell.className = 'portal-shell';
  shell.setAttribute('data-motion', 'off');
  document.body.appendChild(shell);
  render(<EnvironmentFlow flow={PROD_CARD.flow} motion />, { container: shell });
  expect(g.gsap.to).not.toHaveBeenCalled();
  shell.remove();
});

it('nothing built: one dashed gray curve to the placeholder server and no dots', () => {
  const { container } = render(<EnvironmentFlow flow={PLACEHOLDER_PROD.flow} motion />);
  expect(container.querySelectorAll('.sd-flow-dot')).toHaveLength(0);
  expect(g.gsap.to).not.toHaveBeenCalled();
  const curves = container.querySelectorAll('.sd-flow-curve');
  expect(curves).toHaveLength(1);
  curves.forEach((c) => expect(c.getAttribute('class')).toMatch(/is-idle/));
});

it('two slots: solid blue curve to the live slot, dashed to the idle one', () => {
  const { container } = render(<EnvironmentFlow flow={PROD_CARD.flow} motion={false} />);
  const [blue, green] = Array.from(container.querySelectorAll('.sd-flow-curve'));
  expect(blue.getAttribute('class')).toMatch(/is-live/);
  expect(green.getAttribute('class')).toMatch(/is-idle/);
});

it('cleanup clears the inline opacity written by onUpdate', () => {
  const { container, unmount } = render(<EnvironmentFlow flow={PROD_CARD.flow} motion />);
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
    const { unmount } = render(<EnvironmentFlow flow={PROD_CARD.flow} motion />);
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

it('a LAN environment: proxy, one host, dots to it', () => {
  const { container } = render(<EnvironmentFlow flow={LAN_CARD.flow} motion={false} />);
  expect(container.querySelector('.sd-node-lb')!.textContent).toContain('Nginx Proxy Manager');
  expect(container.querySelectorAll('.sd-flow-curve')).toHaveLength(1);
  expect(container.querySelector('.sd-flow-curve')!.getAttribute('class')).toMatch(/is-live/);
  expect(container.querySelectorAll('.sd-flow-dot')).toHaveLength(12);
});

it('the deploying server pulses; a failed one is red while the live one stays lit', () => {
  const deploying = { ...PROD_CARD.flow, deploying_slot: 'green' };
  const { container, unmount } = render(<EnvironmentFlow flow={deploying} motion={false} />);
  const [blue, green] = Array.from(container.querySelectorAll('.sd-slot'));
  expect(green.className).toMatch(/is-deploying/);
  expect(green.textContent).toContain('Deploying');
  expect(blue.className).toMatch(/is-active/);
  unmount();
  const failed = render(<EnvironmentFlow flow={{ ...PROD_CARD.flow, failed_slot: 'green' }} motion={false} />);
  const [blue2, green2] = Array.from(failed.container.querySelectorAll('.sd-slot'));
  expect(green2.className).toMatch(/is-failed/);
  expect(green2.textContent).toContain('Failed');
  expect(blue2.className).toMatch(/is-active/);
  expect(failed.container.querySelector('.sd-flow-curve')!.getAttribute('class')).toMatch(/is-live/);
});

it('a different environment re-measures and restarts the animation', () => {
  const { rerender } = render(<EnvironmentFlow key="prod" flow={PROD_CARD.flow} motion />);
  expect(g.gsap.to).toHaveBeenCalledTimes(12);
  rerender(<EnvironmentFlow key="uat9" flow={CLOUD.environments[1].flow} motion />);
  expect(g.revert).toHaveBeenCalled();
  expect(g.gsap.to).toHaveBeenCalledTimes(24);
});

it('renders the server action next to its box', () => {
  render(<EnvironmentFlow flow={PROD_CARD.flow} motion={false}
                          serverAction={(s) => (s.state === 'idle' ? <button type="button">Activate {s.label}</button> : null)} />);
  expect(screen.getByRole('button', { name: 'Activate Green' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Activate Blue' })).toBeNull();
});

it('the idle server box is dimmed; the live one is not', () => {
  const { container } = render(<EnvironmentFlow flow={PROD_CARD.flow} motion={false} />);
  const [blue, green] = Array.from(container.querySelectorAll('.sd-slot'));
  expect(green.className).toMatch(/is-idle/);
  expect(blue.className).not.toMatch(/is-idle/);
});

it('nothing built: the middle box and its icon are muted', () => {
  const { container } = render(<EnvironmentFlow flow={PLACEHOLDER_PROD.flow} motion={false} />);
  const lb = container.querySelector('.sd-node-lb')!;
  expect(lb.className).toMatch(/is-muted/);
  expect(lb.querySelector('.sd-node-icon')!.getAttribute('class')).toMatch(/is-muted/);
  const live = render(<EnvironmentFlow flow={PROD_CARD.flow} motion={false} />).container.querySelector('.sd-node-lb')!;
  expect(live.className).not.toMatch(/is-muted/);
});

it('a load balancer that is down is red: its border class and its dot', () => {
  const flow = { ...PROD_CARD.flow, middle: { ...PROD_CARD.flow.middle, status: 'down' } };
  const { container } = render(<EnvironmentFlow flow={flow} motion={false} />);
  const lb = container.querySelector('.sd-node-lb')!;
  expect(lb.className).toMatch(/is-down/);
  expect(lb.querySelector('.sd-dot')!.className).toMatch(/is-bad/);
  expect(lb.textContent).toContain('Not found');
});

it('a resize re-measures the connectors', () => {
  let fire: (() => void) | undefined;
  const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(cb: () => void) { fire = cb; }
    observe() {}
    disconnect() {}
  };
  let width = 100;
  const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const traffic = this.classList.contains('sd-node-traffic');
    return { left: traffic ? 0 : width, right: traffic ? 50 : width + 50, top: 0, bottom: 20, height: 20, width: 50,
             x: 0, y: 0, toJSON() {} } as DOMRect;
  });
  try {
    const { container } = render(<EnvironmentFlow flow={LAN_CARD.flow} motion={false} />);
    const before = container.querySelector('.sd-flow-seg')!.getAttribute('d');
    width = 300;
    act(() => fire!());
    expect(container.querySelector('.sd-flow-seg')!.getAttribute('d')).not.toBe(before);
  } finally {
    rect.mockRestore();
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
  }
});
