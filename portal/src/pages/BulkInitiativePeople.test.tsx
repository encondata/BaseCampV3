// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(async () => [
    { id: 'j1', name: 'Dallas Move', type_label: 'Move', client_name: 'Acme',
      scheduled_start: '2026-10-01T00:00:00Z', archived_at: null },
    { id: 'j2', name: 'Dallas Move', type_label: 'Move', client_name: 'Beta',
      scheduled_start: null, archived_at: null },
    { id: 'j3', name: 'Old Job', type_label: 'Project', client_name: null,
      scheduled_start: null, archived_at: '2026-01-01T00:00:00Z' },
  ]),
  downloadTeamTemplate: vi.fn(async () => {}),
  downloadTeamExport: vi.fn(async () => {}),
}));
vi.mock('../lib/api', async (importActual) => ({ ...(await importActual<typeof import('../lib/api')>()), ...api }));
vi.mock('../components/initiatives/TeamBulkUpload', () => ({
  default: ({ jobId }: { jobId: string | null }) => <div data-testid="pane">{jobId ?? ''}</div>,
}));

const { default: BulkInitiativePeople } = await import('./BulkInitiativePeople');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('downloads and the upload pane wait for a job; archived jobs are not offered', async () => {
  render(<MemoryRouter><BulkInitiativePeople /></MemoryRouter>);
  await waitFor(() => expect(api.listInitiatives).toHaveBeenCalled());
  const template = screen.getByRole('button', { name: 'Template (.xlsx)' }) as HTMLButtonElement;
  expect(template.disabled).toBe(true);
  expect(screen.getByTestId('pane').textContent).toBe('');   // rendered, but with no job
  expect(screen.queryByText(/pick a job to upload/i)).toBeNull();
  // the picker is one labeled field under the hint — no "Job" section eyebrow
  expect(screen.queryByText('Job', { selector: '.eyebrow-sm' })).toBeNull();
  expect(screen.getByLabelText('Job', { selector: 'input' })).toBeTruthy();
  fireEvent.focus(screen.getByPlaceholderText(/pick a job/i));
  fireEvent.change(screen.getByPlaceholderText(/pick a job/i), { target: { value: 'Dallas' } });
  expect(await screen.findByText('Move · Acme · Oct 1, 2026')).toBeTruthy();
  expect(screen.getByText('Move · Beta')).toBeTruthy();
  expect(screen.queryByText('Old Job')).toBeNull();
  fireEvent.mouseDown(screen.getByText('Move · Acme · Oct 1, 2026'));
  await waitFor(() => expect(screen.getByTestId('pane').textContent).toBe('j1'));
  fireEvent.click(screen.getByRole('button', { name: 'Template (.xlsx)' }));
  await waitFor(() => expect(api.downloadTeamTemplate).toHaveBeenCalledWith('j1', 'xlsx'));
});
