// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ uploadSnapshot: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import { SNAP } from '../environments/testData';

import UploadSnapshotModal, { nameFromFile, snapshotNameProblem } from './UploadSnapshotModal';

beforeEach(() => { api.uploadSnapshot.mockReset(); api.uploadSnapshot.mockResolvedValue(SNAP); });
afterEach(cleanup);

function open() {
  const onUploaded = vi.fn();
  const onClose = vi.fn();
  render(<UploadSnapshotModal onUploaded={onUploaded} onClose={onClose} />);
  return { onUploaded, onClose };
}
const bundle = (name = 'seed-20261004T120000Z.tar.gz') =>
  new File([new Uint8Array(1536)], name, { type: 'application/gzip' });
const choose = (file: File) => fireEvent.change(screen.getByTestId('snap-file'), { target: { files: [file] } });
const uploadBtn = () => screen.getByRole('button', { name: /^(Upload|Uploading…)$/ }) as HTMLButtonElement;

it('has the modal header and uploads the chosen file with its name and notes', async () => {
  const { onUploaded } = open();
  expect(screen.getByRole('dialog', { name: 'Upload snapshot' })).toBeTruthy();
  expect(screen.getByText('Snapshots')).toBeTruthy();
  expect(screen.getByText(/scripts\/make-seed-snapshot\.sh/)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: /Choose file/ }));
  expect(uploadBtn().disabled).toBe(true);
  choose(bundle());
  expect(screen.getByText('seed-20261004T120000Z.tar.gz · 1.5 KB')).toBeTruthy();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('seed-20261004T120000Z');
  await userEvent.type(screen.getByLabelText('Notes'), 'From the Mac');
  await userEvent.click(uploadBtn());
  await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(SNAP));
  const [file, name, notes] = api.uploadSnapshot.mock.calls[0];
  expect([(file as File).name, name, notes]).toEqual(['seed-20261004T120000Z.tar.gz', 'seed-20261004T120000Z', 'From the Mac']);
});

it('checks the name before uploading', async () => {
  open();
  choose(bundle());
  await userEvent.clear(screen.getByLabelText('Name'));
  await userEvent.type(screen.getByLabelText('Name'), 'bad name');
  expect(screen.getByRole('alert').textContent).toMatch(/^Use letters, numbers/);
  expect(uploadBtn().disabled).toBe(true);
});

it('shows the server reason, the size cap, and a proxy refusal', async () => {
  open();
  choose(bundle());
  api.uploadSnapshot.mockRejectedValueOnce(new ApiError(422, 'bundle_invalid', {
    code: 'bundle_invalid', reason: "db.dump doesn't match its checksum in the manifest." }));
  await userEvent.click(uploadBtn());
  expect((await screen.findByRole('alert')).textContent).toBe("db.dump doesn't match its checksum in the manifest.");
  api.uploadSnapshot.mockRejectedValueOnce(new ApiError(413, 'snapshot_too_large', {
    code: 'snapshot_too_large', max_bytes: 5 * 1024 ** 3 }));
  await userEvent.click(uploadBtn());
  expect((await screen.findByRole('alert')).textContent)
    .toBe('That file is larger than Sirdar accepts (5.0 GB, SIRDAR_SNAPSHOT_MAX_BYTES).');
  api.uploadSnapshot.mockRejectedValueOnce(new ApiError(413, 'http_413'));
  await userEvent.click(uploadBtn());
  expect((await screen.findByRole('alert')).textContent).toBe('That file is larger than the proxy in front of Sirdar accepts.');
});

it('is locked while uploading: no close, no second upload', async () => {
  let finish: (s: typeof SNAP) => void = () => {};
  api.uploadSnapshot.mockReturnValue(new Promise((r) => { finish = r; }));
  const { onClose } = open();
  choose(bundle());
  await userEvent.click(uploadBtn());
  expect(uploadBtn().textContent).toBe('Uploading…');
  expect(screen.getByRole('status').textContent).toMatch(/Keep this page open/);
  await userEvent.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  finish(SNAP);
  await waitFor(() => expect(uploadBtn().textContent).toBe('Upload'));
  expect(api.uploadSnapshot).toHaveBeenCalledTimes(1);
});

it('helpers', () => {
  expect(nameFromFile('seed-20261004T120000Z.tar.gz')).toBe('seed-20261004T120000Z');
  expect(nameFromFile('my dev (copy).tgz')).toBe('my-dev--copy-');
  expect(snapshotNameProblem('')).toBe('');
  expect(snapshotNameProblem('dev-2026.10_04')).toBe('');
  expect(snapshotNameProblem('-x')).not.toBe('');
});
