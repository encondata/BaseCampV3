// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@portal/lib/api')>()),
  accessTokenForService: vi.fn(async () => 'tok'),
  refreshSession: vi.fn(async () => null),
}));

import { FakeXhr, json, stubApi } from '../testing/fakeApi';
import UploadModal from './UploadModal';

const UPLOAD = {
  upload_id: 'up-1',
  put_url: 'https://bucket.test/uploads/up-1/kiosk.apk?sig=x',
  headers: { 'Content-Type': 'application/vnd.android.package-archive' },
};

function inspectOut(over: Record<string, unknown> = {}) {
  return {
    app: { exists: true, id: 'app-a', name: 'ServerSherpa Kiosk', platform: 'android', identifier: 'com.serversherpa.kiosk' },
    version_name: '0.1.2', build: '3', signing_digest: 'ab12cd34ef56ab12cd34ef56ab12cd34', problems: [],
    ...over,
  };
}

const apk = () => new File(['apk-bytes'], 'kiosk.apk', { type: 'application/vnd.android.package-archive' });

async function chooseAndUpload(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  await userEvent.upload(input, apk());
  await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
}

beforeEach(() => {
  FakeXhr.sent = [];
  FakeXhr.status = 200;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('UploadModal', () => {
  it('UploadModal blocks Save when inspect reports problems', async () => {
    const calls = stubApi({
      'POST /api/uploads': () => json(201, UPLOAD),
      'POST /api/uploads/up-1/inspect': inspectOut({
        problems: ['0.1.2 (3) is already uploaded', 'The signing certificate differs from earlier versions'],
      }),
    });
    const { container } = render(<UploadModal onClose={() => {}} onSaved={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Upload a version' });
    expect(within(dialog).getByText('Devices')).toBeTruthy();
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')!.accept).toBe('.apk,.ipa');
    await chooseAndUpload(container);

    await screen.findByText('0.1.2 (3) is already uploaded');
    const problems = [...container.querySelectorAll('.pf-error')].map((e) => e.textContent);
    expect(problems).toEqual(['0.1.2 (3) is already uploaded', 'The signing certificate differs from earlier versions']);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

    // the file went straight to the bucket with the API's headers, no bearer
    expect(FakeXhr.sent).toHaveLength(1);
    expect(FakeXhr.sent[0]).toMatchObject({ method: 'PUT', url: UPLOAD.put_url, headers: UPLOAD.headers });
    expect(FakeXhr.sent[0].headers.Authorization).toBeUndefined();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/uploads', 'POST /api/uploads/up-1/inspect']);
    expect(calls[0].body).toEqual({ filename: 'kiosk.apk', size: 9, content_type: 'application/vnd.android.package-archive' });
  });

  it('shows the review summary and saves the release notes', async () => {
    const calls = stubApi({
      'POST /api/uploads': () => json(201, UPLOAD),
      'POST /api/uploads/up-1/inspect': inspectOut({ app: { exists: false, name: 'ServerSherpa Kiosk', platform: 'android', identifier: 'com.serversherpa.kiosk' } }),
      'POST /api/uploads/up-1/commit': () => json(201, { app_id: 'app-a', version: {} }),
    });
    const onSaved = vi.fn();
    const { container } = render(<UploadModal onClose={() => {}} onSaved={onSaved} />);
    await chooseAndUpload(container);

    await screen.findByText('New app');
    const summary = container.querySelector('.devices-review')!;
    expect(summary.textContent).toContain('0.1.2');
    expect(summary.textContent).toContain('3');
    expect(summary.textContent).toContain('ab12cd34ef56');
    expect(summary.textContent).not.toContain('ab12cd34ef56a');
    expect(container.querySelectorAll('.pf-error')).toHaveLength(0);

    await userEvent.type(screen.getByLabelText('Release notes'), 'QR label changes');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls[2]).toMatchObject({ method: 'POST', path: '/api/uploads/up-1/commit', body: { notes: 'QR label changes' } });
  });

  it('shows the API\'s reason when the upload is refused', async () => {
    stubApi({
      'POST /api/uploads': () => json(413, { detail: { code: 'too_large', message: 'This file is too large to upload.' } }),
    });
    const { container } = render(<UploadModal onClose={() => {}} onSaved={() => {}} />);
    await chooseAndUpload(container);
    expect(await screen.findByText('This file is too large to upload.')).toBeTruthy();
    expect(FakeXhr.sent).toHaveLength(0);
  });
});
