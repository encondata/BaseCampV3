/** The storage leg of an upload: PUT the file to the presigned URL that
 *  `startUpload` returned. XHR rather than fetch, for upload progress.
 *  The URL's signature covers `headers` (Content-Length included), so they
 *  are sent exactly as given and the body is the file as-is. */

export class UploadAbortedError extends Error {
  constructor() {
    super('The upload was canceled.');
    this.name = 'UploadAbortedError';
  }
}

/** A failure from the storage PUT itself (a non-2xx answer, or the
 *  connection dropping) — worded well enough to show as-is. Anything else
 *  the upload queue sees (a raw browser error from somewhere else in the
 *  chain) is not assumed to be presentable and falls back to a generic
 *  message instead. */
export class PutUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PutUploadError';
  }
}

export interface PutUploadOptions {
  /** 0…1 as the bytes go out. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export function putUpload(
  url: string, headers: Record<string, string>, body: Blob, opts: PutUploadOptions = {},
): Promise<void> {
  const { onProgress, signal } = opts;
  if (signal?.aborted) return Promise.reject(new UploadAbortedError());
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const settle = (fn: () => void) => {
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => settle(() => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new PutUploadError(`The storage service refused the upload (${xhr.status}).`));
    });
    xhr.onerror = () => settle(() => reject(new PutUploadError('The upload failed: a network error.')));
    xhr.onabort = () => settle(() => reject(new UploadAbortedError()));
    signal?.addEventListener('abort', onAbort);
    xhr.send(body);
  });
}
