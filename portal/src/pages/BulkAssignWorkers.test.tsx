// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(async () => [
    { id: 'j1', name: 'Dallas Move', type_label: 'Move', client_name: 'Acme',
      scheduled_start: null, archived_at: null },
    { id: 'j3', name: 'Old Job', type_label: 'Project', client_name: null,
      scheduled_start: null, archived_at: '2026-01-01T00:00:00Z' },
  ]),
  listSites: vi.fn(async () => [
    { id: 's1', name: 'Example DC West', archived_at: null },
    { id: 's2', name: 'Closed Site', archived_at: '2026-01-01T00:00:00Z' },
  ]),
  listPartners: vi.fn(async () => [
    { id: 'p1', name: 'Acme Staffing', archived_at: null },
    { id: 'p2', name: 'Gone Partner', archived_at: '2026-01-01T00:00:00Z' },
  ]),
  downloadAssignTemplate: vi.fn(async () => {}),
}));
vi.mock('../lib/api', async (importActual) => ({ ...(await importActual<typeof import('../lib/api')>()), ...api }));
vi.mock('../components/workers/AssignBulkUpload', () => ({
  default: ({ jobId, siteId, partnerId }: { jobId: string; siteId: string; partnerId: string }) => (
    <div data-testid="pane">{`${jobId}|${siteId}|${partnerId}`}</div>
  ),
}));

const { default: BulkAssignWorkers } = await import('./BulkAssignWorkers');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('renders the title, three labeled pickers without archived options, and passes the ids on', async () => {
  render(<MemoryRouter><BulkAssignWorkers /></MemoryRouter>);
  await waitFor(() => expect(api.listPartners).toHaveBeenCalled());
  expect(screen.getByRole('heading', { name: 'Assign workers from a template' })).toBeTruthy();
  for (const label of ['Initiative', 'Site', 'Partner']) {
    expect(screen.getByLabelText(label, { selector: 'input' })).toBeTruthy();
  }
  expect(document.querySelector('.bulk-intro.bulk-intro-3')).toBeTruthy();

  const pick = async (placeholder: RegExp, text: string) => {
    fireEvent.focus(screen.getByPlaceholderText(placeholder));
    fireEvent.mouseDown(await screen.findByText(text));
  };
  await pick(/pick an initiative/i, 'Dallas Move');
  expect(screen.queryByText('Old Job')).toBeNull();
  await pick(/pick a site/i, 'Example DC West');
  expect(screen.queryByText('Closed Site')).toBeNull();
  await pick(/pick a partner/i, 'Acme Staffing');
  expect(screen.queryByText('Gone Partner')).toBeNull();
  await waitFor(() => expect(screen.getByTestId('pane').textContent).toBe('j1|s1|p1'));
});

it('the Template button downloads the template', async () => {
  render(<MemoryRouter><BulkAssignWorkers /></MemoryRouter>);
  const btn = screen.getByRole('button', { name: 'Template (.xlsx)' }) as HTMLButtonElement;
  expect(btn.disabled).toBe(false);
  fireEvent.click(btn);
  await waitFor(() => expect(api.downloadAssignTemplate).toHaveBeenCalled());
});
