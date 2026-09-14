// @vitest-environment jsdom
/** Ported from portal/src/components/printers/PrinterSetupModal.test.tsx
 *  — same fake printer and the same ZPL assertions; the label-size
 *  picker is a native <select> here rather than the portal ComboBox. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostStatus } from '@portal/labels/zebraUsb';

import type { LabelVocab } from '../../lib/api';
import PrinterSetupModal from './PrinterSetupModal';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);

const HH = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    DARKNESS: '+10.0', 'PRINT SPEED': '6.0 IPS', 'TEAR OFF': '+000', 'PRINT MODE': 'TEAR OFF', 'MEDIA TYPE': 'GAP/NOTCH',
    'PRINT METHOD': 'DIRECT-THERMAL', 'PRINT WIDTH': '812', 'LABEL LENGTH': '1218', FIRMWARE: 'V72.19.15Z <-', ...over,
  };
  return '\x02' + Object.entries(base).map(([k, v]) => `${v.padEnd(20)}${k}`).join('\r\n') + '\x03';
};
const status: HostStatus = { paperOut: false, paused: false, labelLength: 1218, formatsQueued: 0, bufferFull: false, partialFormat: false, corruptRam: false, underTemp: false, overTemp: false, headOpen: false, ribbonOut: false, thermalTransfer: false, printMode: '0', labelWaiting: false, labelsRemaining: 0 };
const vocab: LabelVocab[] = [
  { kind: 'size', key: '4x2', label: '4" x 2"', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'size', key: '3x2', label: '3" x 2"', description: '', meta: { width_in: 3, height_in: 2 }, sort_order: 2, is_active: true, usage_count: null },
  { kind: 'dpi', key: '203', label: '203 DPI', description: '', meta: { dots: 203 }, sort_order: 1, is_active: true, usage_count: null },
];

function fakePrinter(config = HH()) {
  const state = { config };
  const printer = {
    productName: 'ZD421',
    query: vi.fn(async (cmd: string) => (cmd === '^XA^HH^XZ' ? state.config : '')),
    send: vi.fn(async (_zpl: string) => undefined),
    identify: vi.fn(async () => ({ model: 'ZD421-203dpi ZPL', firmware: 'V92', dotsPerMm: 8, memory: '8192KB', dpi: 203 })),
    status: vi.fn(async () => status),
    log: [{ at: '2026-09-12T00:00:00Z', command: '~HI', response: 'ZD421' }],
    clearLog: vi.fn(),
  };
  return { printer, state };
}

function setup(config?: string) {
  const { printer, state } = fakePrinter(config);
  const onClose = vi.fn();
  render(<PrinterSetupModal printer={printer} vocab={vocab} identity={{ model: 'ZD421-203dpi ZPL', firmware: 'V92', dotsPerMm: 8, memory: '8192KB', dpi: 203 }} onClose={onClose} />);
  return { printer, state, onClose };
}

describe('PrinterSetupModal', () => {
  it('Identify reads the configuration and shows it', async () => {
    const { printer } = setup();
    expect(screen.getByText('Full printer setup')).toBeTruthy();
    await waitFor(() => expect(printer.query).toHaveBeenCalledWith('^XA^HH^XZ'));
    expect(await screen.findByText('GAP/NOTCH')).toBeTruthy();
    expect(screen.getByText('DIRECT-THERMAL')).toBeTruthy();
    expect(screen.getByText('V72.19.15Z')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
  });
  it('Media: applies only changed settings, re-reads, and confirms', async () => {
    const { printer, state } = setup();
    await screen.findByText('GAP/NOTCH');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('radio', { name: /Gap \/ notch/ }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('radio', { name: /Continuous/ }));
    await userEvent.click(screen.getByRole('radio', { name: /Cutter/ }));
    state.config = HH({ 'MEDIA TYPE': 'CONTINUOUS', 'PRINT MODE': 'CUTTER' });
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA^MNN^XZ'));
    expect(printer.send).toHaveBeenCalledWith('^XA^MMC^XZ');
    expect(printer.send).not.toHaveBeenCalledWith('^XA^MTD^XZ');
    expect(await screen.findByText('Media tracking confirmed', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText('Print mode confirmed')).toBeTruthy();
  });
  it('Media: reports a value the printer did not take', async () => {
    const { printer } = setup();
    await screen.findByText('GAP/NOTCH');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('radio', { name: /Black mark/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA^MNM^XZ'));
    expect(await screen.findByText('Media tracking: printer reports GAP/NOTCH', {}, { timeout: 3000 })).toBeTruthy();
  });
  it('Media: an unreadable re-read after Apply keeps the previous config and Apply enabled', async () => {
    const { printer, state } = setup();
    await screen.findByText('GAP/NOTCH');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('radio', { name: /Continuous/ }));
    state.config = '';
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA^MNN^XZ'));
    expect(await screen.findByText(
      "Commands were sent, but the printer's configuration couldn't be read back (^HH). Refresh on the Identify step to retry.",
      {}, { timeout: 3000 },
    )).toBeTruthy();
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    expect(screen.queryByText(/confirmed$/)).toBeNull();
    expect(screen.queryByText(/printer reports/)).toBeNull();
  });
  it('Calibrate sends ~JC', async () => {
    const { printer } = setup();
    await screen.findByText('GAP/NOTCH');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Calibrate media' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('~JC'));
  });
  it('Print quality: darkness and speed apply and confirm', async () => {
    const { printer, state } = setup();
    await screen.findByText('GAP/NOTCH');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('Darkness'), { target: { value: '14' } });
    fireEvent.change(screen.getByLabelText('Print speed'), { target: { value: '4' } });
    state.config = HH({ DARKNESS: '+14.0', 'PRINT SPEED': '4.0 IPS' });
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('~SD14'));
    expect(printer.send).toHaveBeenCalledWith('^XA^PR4^XZ');
    expect(await screen.findByText('Darkness confirmed', {}, { timeout: 3000 })).toBeTruthy();
  });
  it('Save & verify: save, config label, alignment, guarded factory reset', async () => {
    const { printer } = setup();
    await screen.findByText('GAP/NOTCH');
    for (let i = 0; i < 3; i++) await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save to printer' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA^JUS^XZ'));
    await userEvent.click(screen.getByRole('button', { name: 'Print configuration label' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('~WC'));
    await userEvent.click(screen.getByRole('button', { name: 'Print alignment test' }));
    await waitFor(() => expect(printer.send.mock.calls.some((c) => String(c[0]).includes('^PW812'))).toBe(true));
    expect(printer.send.mock.calls.some((c) => String(c[0]).includes('^LL1218'))).toBe(true);
    expect(printer.send.mock.calls.some((c) => String(c[0]).includes('ALIGN 812x1218 203DPI'))).toBe(true);
    const reset = screen.getByRole('button', { name: 'Restore factory defaults' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Type RESET to confirm'), 'RESET');
    expect(reset.disabled).toBe(false);
    await userEvent.click(reset);
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA^JUF^XZ'));
  });
  it('the native size select keeps the printer size by default and sets ^PW/^LL when picked', async () => {
    const { printer } = setup();
    await screen.findByText('GAP/NOTCH');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    const select = screen.getByLabelText('Label size') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', '4x2', '3x2']);
    await userEvent.selectOptions(select, '3x2');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA^PW609^XZ'));
  });
  it('shows the command log', async () => {
    setup();
    await screen.findByText('GAP/NOTCH');
    await userEvent.click(screen.getByText(/Command log \(1\)/));
    expect(screen.getByText(/~HI/)).toBeTruthy();
  });
});
