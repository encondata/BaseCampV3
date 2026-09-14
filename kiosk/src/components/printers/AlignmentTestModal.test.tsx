// @vitest-environment jsdom
/** Ported from portal/src/components/printers/AlignmentTestModal.test.tsx
 *  — same assertions (the ZPL and the shared `labels.print.settings`
 *  key are identical); the label-size picker is a native <select> here,
 *  so its test reaches for a combobox rather than the portal ComboBox. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LabelVocab } from '../../lib/api';
import AlignmentTestModal from './AlignmentTestModal';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);
beforeEach(() => localStorage.clear());

const vocab: LabelVocab[] = [
  { kind: 'size', key: '4x2', label: '4" x 2"', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'size', key: '2x1', label: '2" x 1"', description: '', meta: { width_in: 2, height_in: 1 }, sort_order: 2, is_active: true, usage_count: null },
  { kind: 'dpi', key: '203', label: '203 DPI', description: '', meta: { dots: 203 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'dpi', key: '300', label: '300 DPI', description: '', meta: { dots: 300 }, sort_order: 2, is_active: true, usage_count: null },
];

function setup(printerDpi: number | null = 203) {
  const onPrint = vi.fn(async (_zpl: string) => undefined);
  const onClose = vi.fn();
  render(<AlignmentTestModal vocab={vocab} printerDpi={printerDpi} onPrint={onPrint} onClose={onClose} />);
  return { onPrint, onClose };
}

describe('AlignmentTestModal', () => {
  it('preselects the printer DPI and prints the 4x2 test with the stored offsets', async () => {
    localStorage.setItem('labels.print.settings', JSON.stringify({ verticalOffset: 5, horizontalOffset: -3 }));
    const { onPrint } = setup(203);
    expect(screen.getByRole('tab', { name: '203 DPI' }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByLabelText('Vertical offset') as HTMLInputElement).value).toBe('5');
    await userEvent.click(screen.getByRole('button', { name: 'Print test label' }));
    const zpl = onPrint.mock.calls[0][0];
    expect(zpl).toContain('^PW812');
    expect(zpl).toContain('^LL406');
    expect(zpl).toContain('^LT5');
    expect(zpl).toContain('^LS3');
    expect(zpl).not.toContain('^PQ');
    expect(await screen.findByText('Alignment test label (4x2) sent to printer')).toBeTruthy();
  });
  it('defaults to 300 DPI without a printer DPI and shows the boxes preview', () => {
    setup(null);
    expect(screen.getByRole('tab', { name: '300 DPI' }).getAttribute('aria-selected')).toBe('true');
    expect(document.querySelectorAll('svg rect').length).toBeGreaterThanOrEqual(3);
  });
  it('the native size select lists every size and re-sizes the test label', async () => {
    const { onPrint } = setup(203);
    const select = screen.getByLabelText('Label size') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['4x2', '2x1']);
    await userEvent.selectOptions(select, '2x1');
    await userEvent.click(screen.getByRole('button', { name: 'Print test label' }));
    expect(onPrint.mock.calls[0][0]).toContain('^PW406');
    expect(await screen.findByText('Alignment test label (2x1) sent to printer')).toBeTruthy();
  });
  it('Save offsets persists edited offsets and is disabled until changed', async () => {
    setup();
    const save = screen.getByRole('button', { name: 'Save offsets' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const v = screen.getByLabelText('Vertical offset');
    fireEvent.change(v, { target: { value: '12' } });
    fireEvent.blur(v);
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    expect(JSON.parse(localStorage.getItem('labels.print.settings') ?? '{}').verticalOffset).toBe(12);
    expect(screen.getByText('Offsets saved — Print Labels will use them.')).toBeTruthy();
  });
  it('shows a print failure', async () => {
    const { onPrint } = setup();
    onPrint.mockRejectedValueOnce(new Error('Printer connection lost. Please reconnect.'));
    await userEvent.click(screen.getByRole('button', { name: 'Print test label' }));
    expect(await screen.findByText('Printer connection lost. Please reconnect.')).toBeTruthy();
  });
  it('closes on Done, ×, and Escape', async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
