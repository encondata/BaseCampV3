// @vitest-environment jsdom
/**
 * DeactivateTemplateModal: the report-generate header naming what goes off
 * (from GET …/deactivate-summary), the amber fallback callout when the
 * deactivate leaves no active Generic Rack and RU at a DPI, and the
 * deactivate itself only once confirmed.
 *
 * RenameTemplateModal: the current name prefilled and selected, a live
 * preview of a parent's DPI version names, Save off while blank or
 * unchanged, the name trimmed, and each refusal in words.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';

const api = vi.hoisted(() => ({
  getLabelTemplateDeactivateSummary: vi.fn(),
  deleteLabelTemplate: vi.fn(),
  updateLabelTemplate: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { DeactivateTemplateModal, RenameTemplateModal, fallbackDpiText } = await import('./TemplateRowDialogs');

const GENERIC = { id: 'g1', name: 'Generic Rack and RU' };
const ROWS = ['Generic Rack and RU', 'Generic Rack and RU · 203', 'Generic Rack and RU · 300',
  'Generic Rack and RU · 600'];

beforeEach(() => {
  vi.clearAllMocks();
  api.getLabelTemplateDeactivateSummary.mockResolvedValue({ rows: ROWS, fallback_dpis_lost: [] });
  api.deleteLabelTemplate.mockResolvedValue(undefined);
  api.updateLabelTemplate.mockResolvedValue({});
});

afterEach(cleanup);

it('has the report-generate header and names what goes off', async () => {
  render(<DeactivateTemplateModal template={GENERIC} onDeactivated={vi.fn()} onClose={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'Deactivate template' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Generic Rack and RU · Deactivate');
  expect(screen.getByRole('heading', { name: 'Deactivate' })).toBeTruthy();
  expect(await screen.findByText('Turns off Generic Rack and RU, Generic Rack and RU · 203, '
    + 'Generic Rack and RU · 300 and Generic Rack and RU · 600.')).toBeTruthy();
  expect(api.getLabelTemplateDeactivateSummary).toHaveBeenCalledWith('g1');
  expect(screen.queryByRole('note')).toBeNull();
});

it('deactivates only once confirmed', async () => {
  const onDeactivated = vi.fn();
  render(<DeactivateTemplateModal template={GENERIC} onDeactivated={onDeactivated} onClose={vi.fn()} />);
  const button = screen.getByRole('button', { name: 'Deactivate' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);                       // until the summary is in
  await screen.findByText(/^Turns off/);
  expect(api.deleteLabelTemplate).not.toHaveBeenCalled();
  await waitFor(() => expect(button.disabled).toBe(false));
  await userEvent.click(button);
  await waitFor(() => expect(onDeactivated).toHaveBeenCalled());
  expect(api.deleteLabelTemplate).toHaveBeenCalledWith('g1');
});

it('Cancel closes without deactivating', async () => {
  const onClose = vi.fn();
  render(<DeactivateTemplateModal template={GENERIC} onDeactivated={vi.fn()} onClose={onClose} />);
  await screen.findByText(/^Turns off/);
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalled();
  expect(api.deleteLabelTemplate).not.toHaveBeenCalled();
});

it('warns when the deactivate leaves no active fallback at a DPI', async () => {
  api.getLabelTemplateDeactivateSummary.mockResolvedValue({ rows: ROWS, fallback_dpis_lost: ['300'] });
  const onDeactivated = vi.fn();
  render(<DeactivateTemplateModal template={GENERIC} onDeactivated={onDeactivated} onClose={vi.fn()} />);
  expect((await screen.findByRole('note')).textContent).toBe('This is the only active Generic Rack and RU '
    + 'template at 300 DPI. Moves without their own Top template will have nothing to print at that DPI until '
    + 'another one is active. To swap templates without a gap, use Replace…');
  // still allowed
  await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
  await waitFor(() => expect(onDeactivated).toHaveBeenCalled());
});

it('names several DPIs naturally', async () => {
  api.getLabelTemplateDeactivateSummary.mockResolvedValue({ rows: ROWS, fallback_dpis_lost: ['203', '300', '600'] });
  render(<DeactivateTemplateModal template={GENERIC} onDeactivated={vi.fn()} onClose={vi.fn()} />);
  expect((await screen.findByRole('note')).textContent).toMatch(
    /at 203, 300 and 600 DPI\. Moves without their own Top template will have nothing to print at those DPIs/);
  expect(fallbackDpiText(['203'])).toBe('203 DPI');
  expect(fallbackDpiText(['203', '300'])).toBe('203 and 300 DPI');
  expect(fallbackDpiText(['203', '300', '600'])).toBe('203, 300 and 600 DPI');
});

it('a summary that fails to load offers Retry and keeps Deactivate off', async () => {
  api.getLabelTemplateDeactivateSummary.mockRejectedValueOnce(new ApiError(500, 'boom'));
  render(<DeactivateTemplateModal template={GENERIC} onDeactivated={vi.fn()} onClose={vi.fn()} />);
  expect(await screen.findByText(/Couldn.t check what goes off/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Deactivate' }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(/^Turns off/)).toBeTruthy();
  await waitFor(() => expect(
    (screen.getByRole('button', { name: 'Deactivate' }) as HTMLButtonElement).disabled).toBe(false));
});

it('shows why a deactivate failed and stays open', async () => {
  api.deleteLabelTemplate.mockRejectedValue(new ApiError(404, 'unknown_template'));
  const onDeactivated = vi.fn();
  render(<DeactivateTemplateModal template={GENERIC} onDeactivated={onDeactivated} onClose={vi.fn()} />);
  await screen.findByText(/^Turns off/);
  await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
  expect((await screen.findByRole('alert')).textContent).toBe('This template no longer exists.');
  expect(onDeactivated).not.toHaveBeenCalled();
});

// ── Rename… ─────────────────────────────────────────────────────────

const VEGAS = { id: 'p1', name: 'Vegas Destination' };
const KIDS = [
  { name: 'Vegas Destination · 203', dpi_key: '203', is_old: false },
  { name: 'Vegas Destination · 300', dpi_key: '300', is_old: false },
  { name: 'Vegas Destination · 300 Old', dpi_key: '300', is_old: true },
  { name: 'Vegas Destination · 600', dpi_key: '600', is_old: false },
];

it('Rename has the report-generate header, the name prefilled and selected', () => {
  render(<RenameTemplateModal template={VEGAS} dpiChildren={KIDS} onRenamed={vi.fn()} onClose={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'Rename template' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Vegas Destination · Rename');
  expect(screen.getByRole('heading', { name: 'Rename' })).toBeTruthy();
  const box = screen.getByLabelText('New name') as HTMLInputElement;
  expect(box.value).toBe('Vegas Destination');
  expect(document.activeElement).toBe(box);
  expect([box.selectionStart, box.selectionEnd]).toEqual([0, 'Vegas Destination'.length]);
});

it('previews what a parent’s DPI versions become, kept old ones too', async () => {
  render(<RenameTemplateModal template={VEGAS} dpiChildren={KIDS} onRenamed={vi.fn()} onClose={vi.fn()} />);
  const box = screen.getByLabelText('New name');
  await userEvent.clear(box);
  await userEvent.type(box, 'Vegas West');
  const preview = screen.getByRole('list', { name: 'DPI versions after the rename' });
  expect([...preview.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
    'Vegas West · 203', 'Vegas West · 300', 'Vegas West · 300 Old', 'Vegas West · 600']);
});

it('an older row has no preview', () => {
  render(<RenameTemplateModal template={{ id: 'l1', name: 'Front tag - 203DPI' }} onRenamed={vi.fn()} onClose={vi.fn()} />);
  expect(screen.queryByRole('list')).toBeNull();
});

it('Rename is off while the name is blank or unchanged, and saves it trimmed', async () => {
  const onRenamed = vi.fn();
  render(<RenameTemplateModal template={VEGAS} dpiChildren={KIDS} onRenamed={onRenamed} onClose={vi.fn()} />);
  const button = screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement;
  const box = screen.getByLabelText('New name');
  expect(button.disabled).toBe(true);                    // unchanged
  await userEvent.clear(box);
  expect(button.disabled).toBe(true);                    // blank
  await userEvent.type(box, '   ');
  expect(button.disabled).toBe(true);                    // only spaces
  await userEvent.clear(box);
  await userEvent.type(box, ' Vegas Destination ');
  expect(button.disabled).toBe(true);                    // the same, trimmed
  await userEvent.clear(box);
  await userEvent.type(box, '  Vegas West  ');
  expect(button.disabled).toBe(false);
  await userEvent.click(button);
  await waitFor(() => expect(onRenamed).toHaveBeenCalled());
  expect(api.updateLabelTemplate).toHaveBeenCalledWith('p1', { name: 'Vegas West' });
});

it('Enter renames', async () => {
  const onRenamed = vi.fn();
  render(<RenameTemplateModal template={VEGAS} onRenamed={onRenamed} onClose={vi.fn()} />);
  const box = screen.getByLabelText('New name');
  await userEvent.clear(box);
  await userEvent.type(box, 'Vegas West{Enter}');
  await waitFor(() => expect(onRenamed).toHaveBeenCalled());
});

it.each([
  [new ApiError(409, 'name_taken'), 'That name is already used by another template.'],
  [new ApiError(409, 'label_template_exists'), 'That name is already used by another template.'],
  [new ApiError(409, 'template_active'), 'This template was activated; deactivate it to rename it.'],
  [new ApiError(404, 'unknown_template'), 'This template no longer exists.'],
  [new ApiError(500, 'boom'), "Couldn't rename the template."],
])('a refusal (%s) says why and stays open', async (err, message) => {
  api.updateLabelTemplate.mockRejectedValue(err);
  const onRenamed = vi.fn();
  render(<RenameTemplateModal template={VEGAS} onRenamed={onRenamed} onClose={vi.fn()} />);
  const box = screen.getByLabelText('New name');
  await userEvent.clear(box);
  await userEvent.type(box, 'Vegas West');
  await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
  expect((await screen.findByRole('alert')).textContent).toBe(message);
  expect(onRenamed).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeTruthy();
});
