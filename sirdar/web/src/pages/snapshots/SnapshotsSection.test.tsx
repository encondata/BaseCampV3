// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'view' || (a === 'add' && perms.add) || (a === 'change' && perms.change)),
  }),
}));
const api = vi.hoisted(() => ({ listSnapshots: vi.fn(), deleteSnapshot: vi.fn(), listEnvironments: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));
vi.mock('./UploadSnapshotModal', () => ({
  default: ({ onUploaded, onClose }: { onUploaded: (s: unknown) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="Upload snapshot">
      <button type="button" onClick={() => onUploaded({})}>fake upload</button>
      <button type="button" onClick={onClose}>fake close</button>
    </div>
  ),
}));
vi.mock('./TakeSnapshotModal', () => ({
  default: ({ envs, onStarted }: { envs: { name: string }[]; onStarted: (r: unknown) => void }) => (
    <div role="dialog" aria-label="Take snapshot">
      <span>{envs.map((e) => e.name).join(',')}</span>
      <button type="button" onClick={() => onStarted({ snapshot: {}, deployment: { id: 'd9', environment: 'uat' } })}>
        fake take</button>
    </div>
  ),
}));

import { ApiError } from '@portal/lib/api';

import { ENV, SNAP, SNAP_TAKING } from '../environments/testData';

import SnapshotsSection, { SNAPSHOTS_POLL_MS } from './SnapshotsSection';

beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.listSnapshots.mockResolvedValue({ snapshots: [SNAP] });
  api.deleteSnapshot.mockResolvedValue(undefined);
  api.listEnvironments.mockResolvedValue({ environments: [ENV, { ...ENV, id: 'e2', name: 'fresh', current_sha: null }] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function Where() {
  const loc = useLocation();
  return <p>at {loc.pathname}{loc.search}</p>;
}
function show() {
  return render(
    <MemoryRouter initialEntries={['/deploy']}>
      <Routes>
        <Route path="/deploy" element={<SnapshotsSection />} />
        <Route path="/deploy/environments/:name" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

it('lists snapshots with source, migration, size, files and status', async () => {
  show();
  const table = await screen.findByRole('table', { name: 'Snapshots' });
  expect(within(table).getByText('dev-2026-10-04')).toBeTruthy();
  expect(within(table).getByText('Seeded from the Mac dev stack')).toBeTruthy();
  expect(within(table).getByText('Upload · mac-dev')).toBeTruthy();
  expect(within(table).getByText('0089')).toBeTruthy();
  expect(within(table).getByText('526.4 MB')).toBeTruthy();
  expect(within(table).getByText('17,603')).toBeTruthy();
  expect(within(table).getByText('Ready')).toBeTruthy();
});

it('a snapshot being taken links to its job, and the list reloads until it is done', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.listSnapshots.mockResolvedValueOnce({ snapshots: [SNAP_TAKING, SNAP] })
    .mockResolvedValue({ snapshots: [{ ...SNAP_TAKING, status: 'ready', alembic_revision: '0089' }, SNAP] });
  show();
  const link = await screen.findByRole('link', { name: 'View the job' });
  expect(link.getAttribute('href')).toBe('/deploy/environments/uat?deployment=d9');
  expect(screen.getByText('Taking')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Delete uat-2026-10-04' })).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOTS_POLL_MS); });
  await waitFor(() => expect(screen.queryByText('Taking')).toBeNull());
  await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOTS_POLL_MS * 3); });
  expect(api.listSnapshots).toHaveBeenCalledTimes(2);
});

it('a failed taken snapshot links to its job so the reason is reachable; a failed upload has none', async () => {
  api.listSnapshots.mockResolvedValue({ snapshots: [
    { ...SNAP_TAKING, status: 'failed' },
    { ...SNAP, id: 's3', name: 'broken-upload', status: 'failed' },
  ] });
  show();
  const table = await screen.findByRole('table');
  const links = await within(table).findAllByRole('link', { name: 'View the job' });
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute('href')).toBe('/deploy/environments/uat?deployment=d9');
  const taken = within(table).getByText('uat-2026-10-04').closest('tr') as HTMLElement;
  expect(within(taken).getByText('Failed')).toBeTruthy();
  expect(within(taken).getByRole('link', { name: 'View the job' })).toBeTruthy();
});

it('deletes after a confirmation', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'Delete dev-2026-10-04' }));
  expect(api.deleteSnapshot).not.toHaveBeenCalled();
  api.listSnapshots.mockResolvedValue({ snapshots: [] });
  await userEvent.click(screen.getByRole('button', { name: 'Delete dev-2026-10-04' }));
  expect(confirm.mock.calls[1][0]).toBe(
    "Delete the snapshot dev-2026-10-04? Its bundle is removed from Sirdar. This can't be undone.");
  expect(await screen.findByText('No snapshots yet.')).toBeTruthy();
  expect(api.deleteSnapshot).toHaveBeenCalledWith('s1');
});

it('a refused delete says why', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.deleteSnapshot.mockRejectedValue(new ApiError(409, 'snapshot_in_use', { code: 'snapshot_in_use' }));
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'Delete dev-2026-10-04' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/^That snapshot is in use/);
});

it('Upload reloads the list; Take snapshot offers deployed environments and opens the job', async () => {
  show();
  await screen.findByText('dev-2026-10-04');
  await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
  await userEvent.click(within(screen.getByRole('dialog', { name: 'Upload snapshot' })).getByRole('button', { name: 'fake upload' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(api.listSnapshots).toHaveBeenCalledTimes(2));
  await userEvent.click(screen.getByRole('button', { name: 'Take snapshot' }));
  const take = await screen.findByRole('dialog', { name: 'Take snapshot' });
  expect(within(take).getByText('uat')).toBeTruthy();                 // "fresh" was never deployed
  await userEvent.click(within(take).getByRole('button', { name: 'fake take' }));
  expect(await screen.findByText('at /deploy/environments/uat?deployment=d9')).toBeTruthy();
});

it('view-only: no Upload, Take snapshot or Delete', async () => {
  perms.add = false; perms.change = false;
  show();
  await screen.findByText('dev-2026-10-04');
  expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Take snapshot' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
});
