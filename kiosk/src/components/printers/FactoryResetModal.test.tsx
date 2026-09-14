// @vitest-environment jsdom
/** Factory reset: confirm → run the reset steps → hand the freshly read
 *  configuration to the setup wizard. The restart poll is on fake timers;
 *  the fake printer stands in for the hook (every command goes through
 *  it, so the page's command log sees them all). */
import { StrictMode } from 'react';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostIdentification } from '@portal/labels/zebraUsb';

import FactoryResetModal from './FactoryResetModal';

const IDENTITY: HostIdentification = { model: 'ZD421-203dpi ZPL', firmware: 'V92.21.16Z', dotsPerMm: 8, memory: '8192KB', dpi: 203 };

const HH = '\x02' + Object.entries({
  DARKNESS: '+10.0', 'PRINT SPEED': '6.0 IPS', 'PRINT MODE': 'TEAR OFF', 'MEDIA TYPE': 'GAP/NOTCH',
  'PRINT METHOD': 'DIRECT-THERMAL', 'PRINT WIDTH': '812', 'LABEL LENGTH': '1218', FIRMWARE: 'V72.19.15Z <-',
}).map(([k, v]) => `${v.padEnd(20)}${k}`).join('\r\n') + '\x03';

/** `identify` fails `failures` times with a WebUSB-style transfer error
 *  (what a rebooting printer throws) before answering. */
function fakePrinter({ failures = 0, identifyAlwaysFails = false } = {}) {
  let seen = 0;
  return {
    productName: 'ZD421',
    send: vi.fn(async (_zpl: string) => undefined),
    query: vi.fn(async (cmd: string) => (cmd === '^XA^HH^XZ' ? HH : '')),
    ensureOpen: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async (_n: number) => undefined),
    identify: vi.fn(async () => {
      if (identifyAlwaysFails || seen++ < failures) throw new Error('A transfer error has occurred.');
      return IDENTITY;
    }),
  };
}

function setup(printer = fakePrinter()) {
  const onDone = vi.fn();
  const onClose = vi.fn();
  render(<FactoryResetModal printer={printer} identity={IDENTITY} onDone={onDone} onClose={onClose} />);
  return { printer, onDone, onClose };
}

/** userEvent's pointer sequence never settles under fake timers, so the
 *  clicks here are plain fireEvent inside act(). */
const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); };

const stateOf = (step: string) => document.querySelector(`[data-step="${step}"]`)?.getAttribute('data-state');
/** Let the poll's 2 s sleeps and the awaits between steps run. */
const tick = async (rounds = 3) => {
  await act(async () => { for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(2000); });
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('FactoryResetModal', () => {
  it('names the printer on the confirm step and does not autofocus the destructive button', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Factory reset' })).toBeTruthy();
    expect(screen.getByText('ZD421')).toBeTruthy();
    expect(screen.getByText(/ZD421-203dpi ZPL/)).toBeTruthy();
    expect(screen.getByText(/V92\.21\.16Z/)).toBeTruthy();
    const danger = screen.getByRole('button', { name: 'Factory reset' });
    expect(document.activeElement).not.toBe(danger);
  });

  it('cancelling sends nothing', async () => {
    const { printer, onClose } = setup();
    await click(screen.getByRole('button', { name: 'Cancel' }));
    expect(printer.send).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('confirming sends the factory defaults command first', async () => {
    const { printer } = setup();
    await click(screen.getByRole('button', { name: 'Factory reset' }));
    expect(printer.send.mock.calls[0][0]).toBe('^XA^JUF^XZ');
    await tick(30);
  });

  it('polls through transfer errors until ~HI answers, marking the steps done in order', async () => {
    const { printer, onDone } = setup(fakePrinter({ failures: 3 }));
    await click(screen.getByRole('button', { name: 'Factory reset' }));
    expect(stateOf('defaults')).toBe('done');
    expect(stateOf('restart')).toBe('running');
    expect(stateOf('save')).toBe('pending');

    await tick(30);
    expect(printer.identify.mock.calls.length).toBeGreaterThan(3);
    expect(printer.ensureOpen).toHaveBeenCalled();
    expect(stateOf('restart')).toBe('done');
    expect(stateOf('calibrate')).toBe('done');
    expect(stateOf('save')).toBe('done');
    expect(stateOf('config')).toBe('done');
    expect(onDone).toHaveBeenCalled();
  });

  it('calibrates only when the box is checked', async () => {
    const { printer } = setup();
    await click(screen.getByRole('checkbox', { name: /Calibrate the media/ }));
    await click(screen.getByRole('button', { name: 'Factory reset' }));
    await tick(30);
    expect(printer.send.mock.calls.map((c) => c[0])).not.toContain('~JC');
    expect(printer.waitForIdle).not.toHaveBeenCalled();
    expect(document.querySelector('[data-step="calibrate"]')).toBeNull();

    cleanup();
    const second = setup();
    await click(screen.getByRole('button', { name: 'Factory reset' }));
    await tick(30);
    expect(second.printer.send.mock.calls.map((c) => c[0])).toContain('~JC');
    expect(second.printer.waitForIdle).toHaveBeenCalled();
  });

  it('a restart timeout shows the power-cycle message and Try again re-runs from the failed step', async () => {
    const printer = fakePrinter({ identifyAlwaysFails: true });
    const { onDone } = setup(printer);
    await click(screen.getByRole('button', { name: 'Factory reset' }));
    await tick(30);
    expect(stateOf('restart')).toBe('failed');
    expect(screen.getByText('The printer did not come back. Power-cycle it, reconnect, and try again.')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(document.querySelector('.modal-foot .mini-btn')?.textContent).toBe('Close');

    const sentBefore = printer.send.mock.calls.length;
    printer.identify.mockResolvedValue(IDENTITY);
    await click(screen.getByRole('button', { name: 'Try again' }));
    await tick(30);
    // re-runs from the restart step, not from the factory-defaults send
    expect(printer.send.mock.calls.slice(sentBefore).map((c) => c[0])).not.toContain('^XA^JUF^XZ');
    expect(stateOf('restart')).toBe('done');
    expect(onDone).toHaveBeenCalled();
  });

  // StrictMode's dev mount/unmount/remount used to trip the run's
  // "still mounted?" guard and abandon it after the first step.
  it('finishes the run under StrictMode', async () => {
    const printer = fakePrinter();
    const onDone = vi.fn();
    render(<StrictMode><FactoryResetModal printer={printer} identity={IDENTITY} onDone={onDone} onClose={vi.fn()} /></StrictMode>);
    await click(screen.getByRole('button', { name: 'Factory reset' }));
    await tick(30);
    expect(stateOf('config')).toBe('done');
    expect(onDone).toHaveBeenCalled();
  });

  it('reads the configuration and hands it to onDone', async () => {
    const { printer, onDone } = setup();
    await click(screen.getByRole('button', { name: 'Factory reset' }));
    await tick(30);
    expect(printer.query).toHaveBeenCalledWith('^XA^HH^XZ');
    expect(printer.send.mock.calls.map((c) => c[0])).toEqual(['^XA^JUF^XZ', '~JC', '^XA^JUS^XZ']);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0]).toMatchObject({ darkness: 10, printSpeed: 6, mediaType: 'GAP/NOTCH', printWidth: 812 });
  });
});
