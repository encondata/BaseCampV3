// @vitest-environment jsdom
/**
 * DeactivateTemplateModal: the report-generate header naming what goes off
 * (from GET …/deactivate-summary), the amber fallback callout when the
 * deactivate leaves no active Generic Rack and RU at a DPI, and the
 * deactivate itself only once confirmed.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';

const api = vi.hoisted(() => ({
  getLabelTemplateDeactivateSummary: vi.fn(),
  deleteLabelTemplate: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { DeactivateTemplateModal, fallbackDpiText } = await import('./TemplateRowDialogs');

const GENERIC = { id: 'g1', name: 'Generic Rack and RU' };
const ROWS = ['Generic Rack and RU', 'Generic Rack and RU · 203', 'Generic Rack and RU · 300',
  'Generic Rack and RU · 600'];

beforeEach(() => {
  vi.clearAllMocks();
  api.getLabelTemplateDeactivateSummary.mockResolvedValue({ rows: ROWS, fallback_dpis_lost: [] });
  api.deleteLabelTemplate.mockResolvedValue(undefined);
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
