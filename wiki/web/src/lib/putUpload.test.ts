import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeXhr } from '../testing/fakeXhr';
import { putUpload, UploadAbortedError } from './putUpload';

const file = new Blob(['hello world'], { type: 'text/plain' });
const signed = { 'Content-Type': 'text/plain', 'x-amz-acl': 'private' };

beforeEach(() => {
  FakeXhr.reset();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('putUpload', () => {
  it('PUTs the file as-is with exactly the signed headers and reports progress', async () => {
    const progress: number[] = [];
    const done = putUpload('https://s3/put', signed, file, { onProgress: (f) => progress.push(f) });
    const xhr = FakeXhr.instances[0];
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://s3/put');
    expect(xhr.headers).toEqual(signed);
    expect(xhr.body).toBe(file);
    xhr.progress(5, 10);
    xhr.progress(10, 10);
    xhr.respond(200);
    await expect(done).resolves.toBeUndefined();
    expect(progress).toEqual([0.5, 1]);
  });

  it('rejects on a non-2xx answer and on a network error', async () => {
    const refused = putUpload('https://s3/put', signed, file);
    FakeXhr.instances[0].respond(403);
    await expect(refused).rejects.toThrow(/403/);

    const offline = putUpload('https://s3/put', signed, file);
    FakeXhr.instances[1].fail();
    await expect(offline).rejects.toThrow(/network/i);
  });

  it('aborts through the signal', async () => {
    const ctl = new AbortController();
    const done = putUpload('https://s3/put', signed, file, { signal: ctl.signal });
    ctl.abort();
    await expect(done).rejects.toBeInstanceOf(UploadAbortedError);
    expect(FakeXhr.instances[0].aborted).toBe(true);
  });

  it('never starts when the signal is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(putUpload('https://s3/put', signed, file, { signal: ctl.signal }))
      .rejects.toBeInstanceOf(UploadAbortedError);
    expect(FakeXhr.instances).toHaveLength(0);
  });
});
