// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import BulkUpload, { type BulkPreviewRow, type BulkUploadConfig } from './BulkUpload';
import type { BulkSummaryRow } from './BulkApplySummary';

afterEach(cleanup);

const row: BulkPreviewRow = {
  row: 2, name: 'Bob Smith', action: 'create', matched_by: null, matched_name: null,
  errors: [], diff: null, cells: {}, data: null,
  notes: ['person_id not found here'],
} as BulkPreviewRow;

function config(over: Partial<BulkUploadConfig<BulkPreviewRow, BulkSummaryRow>> = {}) {
  return {
    idPrefix: 'thing', noun: 'thing', newLabel: 'new thing', errors: {},
    preview: vi.fn(async () => ({ rows: [row], can_commit: true })),
    commit: vi.fn(),
    idOf: () => null,
    summary: { entityLabel: 'Thing', linkFor: () => '/', filename: 'f', openTo: '/', openLabel: 'Open' },
    ...over,
  } as BulkUploadConfig<BulkPreviewRow, BulkSummaryRow>;
}

it('defaults to csv and xlsx', () => {
  const { container } = render(<BulkUpload config={config()} />);
  expect(container.querySelector('input[type=file]')?.getAttribute('accept')).toBe('.csv,.xlsx');
  expect(screen.getByLabelText('Upload a file (.csv or .xlsx)')).toBeTruthy();
});

it('takes the file types from the config', () => {
  const { container } = render(<BulkUpload config={config({ fileTypes: ['.csv', '.xlsx', '.json'] })} />);
  expect(container.querySelector('input[type=file]')?.getAttribute('accept')).toBe('.csv,.xlsx,.json');
  expect(screen.getByLabelText('Upload a file (.csv, .xlsx or .json)')).toBeTruthy();
});

it('shows a preview row note in the Details cell', async () => {
  const { container } = render(<BulkUpload config={config()} />);
  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], 'a.csv')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  const note = await waitFor(() => screen.getByText('person_id not found here'));
  expect(note.className).toBe('muted');
});
