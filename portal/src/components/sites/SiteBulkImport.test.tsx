// @vitest-environment jsdom
/**
 * Bulk pane behavior that nothing else guards: the Import button's gating.
 * It must stay disabled while any row errors exist, and — on the god path —
 * until every `update` row is explicitly approved.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { BulkPreview } from '../../lib/api';

const api = vi.hoisted(() => ({
  getSiteBulkSample: vi.fn(),
  previewSiteBulk: vi.fn(),
  commitSiteBulk: vi.fn(),
  downloadSiteTemplate: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

beforeEach(() => {
  vi.clearAllMocks();
  api.getSiteBulkSample.mockResolvedValue([{ name: 'Example DC West' }]);
});

afterEach(cleanup);

const { default: SiteBulkImport } = await import('./SiteBulkImport');

function preview(rows: BulkPreview['rows'], extra?: Partial<BulkPreview>): BulkPreview {
  return {
    rows,
    can_commit: rows.every((r) => r.action !== 'error'),
    update_allowed: false,
    ...extra,
  };
}

function renderPane() {
  const onDone = vi.fn().mockResolvedValue(undefined);
  render(<SiteBulkImport onDone={onDone} />);
  return { onDone };
}

const importButton = () =>
  screen.getByRole('button', { name: /^import/i }) as HTMLButtonElement;

it('prefills the textarea with the sample and renders template buttons', async () => {
  renderPane();
  await waitFor(() => {
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(box.value).toBe(JSON.stringify([{ name: 'Example DC West' }], null, 2));
  });
  expect(screen.getByRole('button', { name: /template \(\.xlsx\)/i })).toBeDefined();
  expect(screen.getByRole('button', { name: /template \(\.csv\)/i })).toBeDefined();
});

it('shows preview rows and keeps Import disabled while errors exist', async () => {
  const user = userEvent.setup();
  api.previewSiteBulk.mockResolvedValue(preview([
    { row: 1, name: 'Good DC', action: 'create', errors: [], diff: null,
      site_id: null, data: { name: 'Good DC' } },
    { row: 2, name: null, action: 'error', errors: ['name is required'],
      diff: null, site_id: null, data: null },
  ]));

  renderPane();
  await user.click(screen.getByRole('button', { name: /preview/i }));

  expect(await screen.findByText('name is required')).toBeDefined();
  expect(screen.getByText('Good DC')).toBeDefined();
  expect(importButton().disabled).toBe(true);
});

it('gates Import on approving every update row, then commits approved ids', async () => {
  const user = userEvent.setup();
  api.previewSiteBulk.mockResolvedValue(preview(
    [
      { row: 1, name: 'New DC', action: 'create', errors: [], diff: null,
        site_id: null, data: { name: 'New DC' } },
      { row: 2, name: 'Old DC', action: 'update', errors: [],
        diff: { city: { old: 'Reno', new: 'Vegas' } },
        site_id: 'site-42', data: { name: 'Old DC', city: 'Vegas' } },
    ],
    { update_allowed: true },
  ));
  api.commitSiteBulk.mockResolvedValue({ created: 1, updated: 1, unchanged: 0 });

  const { onDone } = renderPane();
  await user.click(screen.getByRole('button', { name: /preview/i }));

  await screen.findByText('Old DC');
  expect(importButton().disabled).toBe(true);

  await user.click(screen.getByRole('checkbox', { name: /approve/i }));
  expect(importButton().disabled).toBe(false);

  await user.click(importButton());
  await waitFor(() => expect(api.commitSiteBulk).toHaveBeenCalledWith(
    [{ name: 'New DC' }, { name: 'Old DC', city: 'Vegas' }],
    ['site-42'],
    'paste',
  ));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
});
