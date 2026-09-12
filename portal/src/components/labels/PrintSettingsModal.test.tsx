// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LabelVocab } from '../../lib/api';
import { DEFAULT_PRINT_SETTINGS, type PrintSettings } from '../../lib/printLabels';
import PrintSettingsModal from './PrintSettingsModal';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);

const vocab: LabelVocab[] = [
  { kind: 'size', key: '4x2', label: '4" x 2"', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'size', key: '2x1', label: '2" x 1"', description: '', meta: { width_in: 2, height_in: 1 }, sort_order: 2, is_active: true, usage_count: null },
  { kind: 'dpi', key: '203', label: '203 DPI', description: '', meta: { dots: 203 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'dpi', key: '300', label: '300 DPI', description: '', meta: { dots: 300 }, sort_order: 2, is_active: true, usage_count: null },
];

function setup(over: Partial<PrintSettings> = {}, printerConnected = true) {
  const onChange = vi.fn();
  const onPrintAlignmentTest = vi.fn(async (_zpl: string, _sizeLabel: string) => undefined);
  const onClose = vi.fn();
  const settings = { ...DEFAULT_PRINT_SETTINGS, ...over };
  const view = render(
    <PrintSettingsModal settings={settings} onChange={onChange} vocab={vocab}
                        printerConnected={printerConnected}
                        onPrintAlignmentTest={onPrintAlignmentTest} onClose={onClose} />);
  return { onChange, onPrintAlignmentTest, onClose, view };
}

describe('PrintSettingsModal', () => {
  it('renders the roomy header and every V2 field with its hint', () => {
    setup();
    expect(screen.getByText('Print settings')).toBeTruthy();
    expect(screen.getByText('Print Labels')).toBeTruthy();
    expect(screen.getByLabelText('Vertical offset')).toBeTruthy();
    expect(screen.getByLabelText('Horizontal offset')).toBeTruthy();
    expect(screen.getByLabelText('Copies')).toBeTruthy();
    expect(screen.getByLabelText('Batch size')).toBeTruthy();
    expect(screen.getByLabelText('Blanks between racks')).toBeTruthy();
    expect(screen.getByText('Offset in dots (+ moves down)')).toBeTruthy();
    expect(screen.getByText('Offset in dots (+ moves right)')).toBeTruthy();
    expect(screen.getByText('Labels per batch before pausing')).toBeTruthy();
  });

  it('emits clamped numeric changes on blur and boolean changes immediately', async () => {
    const { onChange } = setup();
    const copies = screen.getByLabelText('Copies') as HTMLInputElement;
    fireEvent.change(copies, { target: { value: '150' } });
    fireEvent.blur(copies);
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_PRINT_SETTINGS, copies: 99 });
    const vertical = screen.getByLabelText('Vertical offset') as HTMLInputElement;
    fireEvent.change(vertical, { target: { value: '-12' } });
    fireEvent.blur(vertical);
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_PRINT_SETTINGS, verticalOffset: -12 });
    await userEvent.click(screen.getByLabelText('Print by rack'));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_PRINT_SETTINGS, printByRack: true });
  });

  it('disables Blanks between racks until Print by rack is on', () => {
    setup();
    expect((screen.getByLabelText('Blanks between racks') as HTMLInputElement).disabled).toBe(true);
    cleanup();
    setup({ printByRack: true });
    expect((screen.getByLabelText('Blanks between racks') as HTMLInputElement).disabled).toBe(false);
  });

  it('Reset is disabled at defaults and restores them when modified', async () => {
    const { onChange } = setup({ copies: 3, printByRack: true });
    const reset = screen.getByRole('button', { name: 'Reset' });
    expect((reset as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(reset);
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_PRINT_SETTINGS);
    cleanup();
    setup();
    expect((screen.getByRole('button', { name: 'Reset' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('prints an alignment test for the chosen size × DPI (default 4x2 @ 300)', async () => {
    const { onPrintAlignmentTest } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Print test label' }));
    expect(onPrintAlignmentTest).toHaveBeenCalledTimes(1);
    const [zpl, sizeLabel] = onPrintAlignmentTest.mock.calls[0];
    expect(sizeLabel).toBe('4x2');
    expect(zpl).toContain('^PW1200');
    expect(zpl).toContain('^LL600');
    expect(zpl).toContain('ALIGN 4x2 300DPI');
    await userEvent.click(screen.getByRole('tab', { name: '203 DPI' }));
    await userEvent.click(screen.getByRole('button', { name: 'Print test label' }));
    expect(onPrintAlignmentTest.mock.calls[1][0]).toContain('^PW812');
  });

  it('gates the alignment test on a connected printer', () => {
    setup({}, false);
    expect((screen.getByRole('button', { name: 'Print test label' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Connect a printer first')).toBeTruthy();
  });

  it('closes on Done, the × button, and Escape', async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
