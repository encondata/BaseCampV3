// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { alignmentTestZpl, applyPrintSettings, DEFAULT_PRINT_SETTINGS } from '@portal/lib/printLabels';

const apiMock = vi.hoisted(() => ({ postTestRender: vi.fn() }));
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, ...apiMock };
});

import type { KioskLabelTemplate } from '../../lib/api';
import { withPrintMode, type StationPrinter } from '../../lib/stationPrinter';
import TestLabelModal from './TestLabelModal';

function template(over: Partial<KioskLabelTemplate>): KioskLabelTemplate {
  return {
    id: 't', name: 'T', label_type: 'top', size_key: '4x2', dpi_key: '300', language_key: 'zpl',
    version: 1, updated_at: '2026-10-19T00:00:00Z', move_site_names: [], reasons: ['generic'],
    code: '^XA^XZ', generation_rules: {}, width_in: 4, height_in: 2, dots: 300, error: null, ...over,
  };
}

const TEMPLATES = [
  template({ id: 'g203', name: 'Generic Rack and RU', dpi_key: '203' }),
  template({ id: 'f300', name: 'Front 2x1', label_type: 'front', size_key: '2x1', dpi_key: '300' }),
];

function fakePrinter(): StationPrinter & { sent: string[] } {
  const sent: string[] = [];
  return {
    kind: 'network', ip: '10.0.0.40', serial: null, sent,
    identify: vi.fn(), status: vi.fn(), peeler: vi.fn(), query: vi.fn(),
    send: vi.fn(async (zpl: string) => { sent.push(zpl); }),
    sendFont: vi.fn(),
  };
}

/** What goes to the printer: the offsets shift, then the print mode. */
const shifted = (zpl: string, x: number, y: number, peel = false) => withPrintMode(applyPrintSettings(
  zpl, { ...DEFAULT_PRINT_SETTINGS, horizontalOffset: x, verticalOffset: y }, { singleCopy: true }), peel);

beforeEach(() => {
  apiMock.postTestRender.mockReset().mockResolvedValue({ zpl: '^XA^PW812^FDrendered^FS^XZ', template_name: 'Generic Rack and RU' });
});
afterEach(cleanup);

function renderModal(over: Partial<Parameters<typeof TestLabelModal>[0]> = {}) {
  const printer = fakePrinter();
  const onOffsets = vi.fn();
  const props = {
    printer, dpi: 203, labelKind: 'top' as const, templates: TEMPLATES, initiativeId: 'i-1',
    offsets: { x: 12, y: -4 }, peel: false, onOffsets, onClose: vi.fn(), ...over,
  };
  render(<TestLabelModal {...props} />);
  return { printer: props.printer as ReturnType<typeof fakePrinter>, onOffsets };
}

it('uses the report-generate header pattern', () => {
  renderModal();
  const dialog = screen.getByRole('dialog', { name: 'Test labels' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Label Station');
  expect(dialog.querySelector('h3')?.textContent).toBe('Test labels');
});

it('prints the alignment label at the chosen size and the printer DPI with offsets applied', async () => {
  const user = userEvent.setup();
  const { printer } = renderModal();
  expect(screen.getByRole('tab', { name: '4x2' }).getAttribute('aria-selected')).toBe('true');
  await user.click(screen.getByRole('button', { name: 'Print test label' }));
  await waitFor(() => expect(printer.sent).toHaveLength(1));
  expect(printer.sent[0]).toBe(shifted(alignmentTestZpl(812, 406, '4x2', 203), 12, -4));
  await screen.findByRole('button', { name: 'Reprint' });

  await user.click(screen.getByRole('tab', { name: '2x1' }));
  await user.click(screen.getByRole('button', { name: 'Reprint' }));
  await waitFor(() => expect(printer.sent).toHaveLength(2));
  expect(printer.sent[1]).toBe(shifted(alignmentTestZpl(406, 203, '2x1', 203), 12, -4));
});

it('defaults the alignment size to 2x1 for a Front station', () => {
  renderModal({ labelKind: 'front', dpi: 300 });
  expect(screen.getByRole('tab', { name: '2x1' }).getAttribute('aria-selected')).toBe('true');
});

it('prints the mock label from test-render with offsets applied', async () => {
  const user = userEvent.setup();
  const { printer } = renderModal();
  await user.click(screen.getByRole('radio', { name: /Mock-data label/ }));
  expect(screen.getByText(/Generic Rack and RU at 203 DPI/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Print test label' }));
  await waitFor(() => expect(printer.sent).toHaveLength(1));
  expect(apiMock.postTestRender).toHaveBeenCalledWith({ initiative_id: 'i-1', template_id: 'g203', dpi_key: '203' });
  expect(printer.sent[0]).toBe(shifted('^XA^PW812^FDrendered^FS^XZ', 12, -4));
});

it('prints peel-off (^MMP) on a station with a peeler, for both test labels', async () => {
  const user = userEvent.setup();
  const { printer } = renderModal({ peel: true });
  await user.click(screen.getByRole('button', { name: 'Print test label' }));
  await waitFor(() => expect(printer.sent).toHaveLength(1));
  expect(printer.sent[0]).toBe(shifted(alignmentTestZpl(812, 406, '4x2', 203), 12, -4, true));
  expect(printer.sent[0]).toMatch(/^\^XA\^MMP/);
  expect(printer.sent[0]).not.toContain('^MMT');
  await user.click(screen.getByRole('radio', { name: /Mock-data label/ }));
  await user.click(screen.getByRole('button', { name: 'Reprint' }));
  await waitFor(() => expect(printer.sent).toHaveLength(2));
  expect(printer.sent[1]).toBe(shifted('^XA^PW812^FDrendered^FS^XZ', 12, -4, true));
  expect(printer.sent[1]).toContain('^XA^MMP');
});

it('prints tear-off (^MMT) without a peeler, and never saves the mode', async () => {
  const user = userEvent.setup();
  const { printer } = renderModal({ peel: false });
  await user.click(screen.getByRole('button', { name: 'Print test label' }));
  await waitFor(() => expect(printer.sent).toHaveLength(1));
  expect(printer.sent[0]).toMatch(/^\^XA\^MMT/);
  expect(printer.sent[0]).not.toMatch(/\^MMP|\^JUS|setvar/);
});

it('skips a mock template that only exists at another DPI, with a note', async () => {
  const user = userEvent.setup();
  renderModal({ labelKind: 'front', dpi: 203 });
  await user.click(screen.getByRole('radio', { name: /Mock-data label/ }));
  expect(screen.getByText('"Front 2x1" is only available at 300 DPI, so the mock-data label is skipped.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Print test label' }) as HTMLButtonElement).disabled).toBe(true);
  expect(apiMock.postTestRender).not.toHaveBeenCalled();
});

it('shows carried-over offsets before the first print', () => {
  renderModal({ offsets: { x: 12, y: -4 } });
  expect((screen.getByLabelText('Horizontal offset') as HTMLInputElement).value).toBe('12');
  expect((screen.getByLabelText('Vertical offset') as HTMLInputElement).value).toBe('-4');
});

it('shows offsets after a print, and Reprint uses the new offsets', async () => {
  const user = userEvent.setup();
  const { printer, onOffsets } = renderModal({ offsets: { x: 0, y: 0 } });
  // nothing carried over: the offsets wait for the first print
  expect(screen.queryByLabelText('Horizontal offset')).toBeNull();
  await user.click(screen.getByRole('radio', { name: /Mock-data label/ }));
  await user.click(screen.getByRole('button', { name: 'Print test label' }));
  await waitFor(() => expect(printer.sent).toHaveLength(1));
  await screen.findByRole('button', { name: 'Reprint' });

  const h = screen.getByLabelText('Horizontal offset');
  const v = screen.getByLabelText('Vertical offset');
  await user.clear(h);
  await user.type(h, '-20');
  await user.clear(v);
  await user.type(v, '8');
  await user.click(screen.getByRole('button', { name: 'Reprint' }));
  await waitFor(() => expect(printer.sent).toHaveLength(2));
  expect(printer.sent[1]).toBe(shifted('^XA^PW812^FDrendered^FS^XZ', -20, 8));
  expect(onOffsets).toHaveBeenLastCalledWith({ x: -20, y: 8 });
  // the rendered label is reused, never re-rendered for a reprint
  expect(apiMock.postTestRender).toHaveBeenCalledTimes(1);
});

it('the offset hints say the printing moves, and give dots per mm at the printer DPI', () => {
  renderModal({ dpi: 203, offsets: { x: 4, y: 0 } });
  expect(screen.getByText('+ moves the printing right on the label, − moves it left. 8 dots ≈ 1 mm at 203 DPI.')).toBeTruthy();
  expect(screen.getByText('+ moves the printing down on the label, − moves it up. 8 dots ≈ 1 mm at 203 DPI.')).toBeTruthy();
  cleanup();
  renderModal({ dpi: 300, offsets: { x: 4, y: 0 } });
  expect(screen.getByText('+ moves the printing right on the label, − moves it left. 12 dots ≈ 1 mm at 300 DPI.')).toBeTruthy();
});
