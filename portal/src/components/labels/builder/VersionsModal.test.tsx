// @vitest-environment jsdom
/**
 * Versions: one line per save with what changed, the note, who and when;
 * Open hands the version to the page, Restore saves it again as the next
 * version (asking first over unsaved changes), and a note is written in
 * place.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { LabelTemplateVersion } from '../../../lib/api';

const api = vi.hoisted(() => ({
  listLabelTemplateVersions: vi.fn(), getLabelTemplateVersion: vi.fn(), noteLabelTemplateVersion: vi.fn(),
  restoreLabelTemplateVersion: vi.fn(),
}));
vi.mock('../../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../../lib/api')>()), ...api,
}));

const { default: VersionsModal } = await import('./VersionsModal');

const version = (v: number, summary: string, note = '', edits = 0): LabelTemplateVersion => ({
  version: v, child_edits: edits, label: edits ? `v${v}.${edits}` : `v${v}`, summary, note,
  created_by: 'u1', created_by_name: 'Jimmy Henderson', created_at: '2026-10-19T15:04:00Z',
});

const VERSIONS = [
  version(7, 'Moved 2 elements'),
  version(6, 'Added Serial', 'Before the Vegas walk-through'),
  version(5, 'Created'),
];

function setup(dirty = false) {
  const onOpen = vi.fn();
  const onRestored = vi.fn();
  const onClose = vi.fn();
  render(<VersionsModal templateId="p1" templateName="Vegas Destination" current="v7" dirty={dirty}
    onOpen={onOpen} onRestored={onRestored} onClose={onClose} />);
  const dialog = screen.getByRole('dialog', { name: 'Versions of Vegas Destination' });
  return { dialog, onOpen, onRestored, onClose };
}

const lineOf = (dialog: HTMLElement, label: string) =>
  within(dialog).getByText(label, { selector: '.lbb-ver' }).closest('tr') as HTMLElement;

beforeEach(() => {
  api.listLabelTemplateVersions.mockResolvedValue(VERSIONS);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('lists every save, newest first, with the current one marked', async () => {
  const { dialog } = setup();
  await within(dialog).findByText('Moved 2 elements');
  expect(api.listLabelTemplateVersions).toHaveBeenCalledWith('p1');
  const labels = [...dialog.querySelectorAll('.lbb-ver')].map((el) => el.firstChild?.textContent);
  expect(labels).toEqual(['v7', 'v6', 'v5']);
  const current = lineOf(dialog, 'v7');
  expect(within(current).getByText('Current')).toBeTruthy();
  expect(within(current).queryByRole('button', { name: 'Restore' })).toBeNull();
  const older = lineOf(dialog, 'v6');
  expect(within(older).getByText('Before the Vegas walk-through')).toBeTruthy();
  expect(within(older).getByText('Jimmy Henderson')).toBeTruthy();
  expect(within(older).getByRole('button', { name: 'Restore' })).toBeTruthy();
});

it('opens a version for the page to show', async () => {
  const detail = { ...VERSIONS[1], design: { schema: 2 }, code: null, samples: {} };
  api.getLabelTemplateVersion.mockResolvedValue(detail);
  const { dialog, onOpen } = setup();
  await within(dialog).findByText('Added Serial');
  fireEvent.click(within(lineOf(dialog, 'v6')).getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(detail));
  expect(api.getLabelTemplateVersion).toHaveBeenCalledWith('p1', 6, 0);
});

it('restores a version as the next one', async () => {
  const saved = { id: 'p1', version: 8, out_of_date: [] };
  api.restoreLabelTemplateVersion.mockResolvedValue(saved);
  const { dialog, onRestored } = setup();
  await within(dialog).findByText('Created');
  fireEvent.click(within(lineOf(dialog, 'v5')).getByRole('button', { name: 'Restore' }));
  await waitFor(() => expect(onRestored).toHaveBeenCalledWith(saved));
  expect(api.restoreLabelTemplateVersion).toHaveBeenCalledWith('p1', 5, 0);
});

it('asks before a restore drops unsaved changes', async () => {
  api.restoreLabelTemplateVersion.mockResolvedValue({ id: 'p1', version: 8 });
  const { dialog, onRestored } = setup(true);
  await within(dialog).findByText('Created');
  fireEvent.click(within(lineOf(dialog, 'v5')).getByRole('button', { name: 'Restore' }));
  expect(api.restoreLabelTemplateVersion).not.toHaveBeenCalled();
  expect(within(dialog).getByText('Restoring v5 discards your unsaved changes.')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Discard and restore' }));
  await waitFor(() => expect(onRestored).toHaveBeenCalled());
  expect(api.restoreLabelTemplateVersion).toHaveBeenCalledWith('p1', 5, 0);
});

it('writes a note in place', async () => {
  api.noteLabelTemplateVersion.mockResolvedValue({ ...VERSIONS[0], note: 'Nudged the RU', design: null, code: null, samples: {} });
  const { dialog } = setup();
  await within(dialog).findByText('Moved 2 elements');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add a note to v7' }));
  const box = within(dialog).getByLabelText('Note on v7');
  fireEvent.change(box, { target: { value: 'Nudged the RU' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(api.noteLabelTemplateVersion).toHaveBeenCalledWith('p1', 7, 0, 'Nudged the RU'));
  expect(await within(dialog).findByRole('button', { name: 'Edit the note on v7' })).toBeTruthy();
  expect(within(dialog).getByText('Nudged the RU')).toBeTruthy();
});

it('Escape in a note drops it and keeps the dialog open', async () => {
  const { dialog, onClose } = setup();
  await within(dialog).findByText('Moved 2 elements');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add a note to v7' }));
  fireEvent.keyDown(within(dialog).getByLabelText('Note on v7'), { key: 'Escape' });
  expect(api.noteLabelTemplateVersion).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(within(dialog).getByRole('button', { name: 'Add a note to v7' })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});
