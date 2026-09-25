// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ downloadTimeImportTemplate: vi.fn(async () => {}) }));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));
vi.mock('../components/time/TimeImportUpload', () => ({
  default: () => <div data-testid="pane" />,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const { default: BulkTime } = await import('./BulkTime');

it('lays out like the other bulk tools: hint, Columns, Download (templates only), Upload', async () => {
  render(<MemoryRouter><BulkTime /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Add time punches in bulk' })).toBeTruthy();
  const sections = screen.getAllByText(/^(Columns|Download|Upload)$/, { selector: '.eyebrow-sm' });
  expect(sections.map((s) => s.textContent)).toEqual(['Columns', 'Download', 'Upload']);
  for (const key of ['worker', 'clock_in', 'clock_out', 'break_minutes', 'job', 'site', 'notes']) {
    expect(screen.getByText(key)).toBeTruthy();
  }
  expect(screen.getAllByRole('button', { name: /^Template \(\.(xlsx|csv)\)$/ })).toHaveLength(2);
  expect(screen.queryByRole('button', { name: /^Current/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Template (.csv)' }));
  await waitFor(() => expect(api.downloadTimeImportTemplate).toHaveBeenCalledWith('csv'));
  expect(screen.getByText('Uploads are limited to 5,000 rows and 5 MB. Split larger files before uploading.')).toBeTruthy();
  expect(screen.getByTestId('pane')).toBeTruthy();
  expect(screen.getByText(/A time without an offset is read in the time zone of the row's site, or of the job's site when the row has none, and in Eastern time otherwise\./))
    .toBeTruthy();
});
