// @vitest-environment jsdom
/**
 * The label image client (ID badges): the raster route's gray bytes and
 * size headers, "no picture" (404 `no_image`) as null, other refusals as
 * ApiError; the image library's list, upload and delete.
 */

import { afterEach, expect, it, vi } from 'vitest';

import {
  ApiError, deleteLabelImage, labelImageRaster, listLabelImages, uploadLabelImage, type LabelImage,
  type LabelImageRasterBody,
} from './api';

afterEach(() => vi.unstubAllGlobals());

const BODY: LabelImageRasterBody = {
  source: 'photo', person_id: '0b7f3c52-6a2e-4c41-9d1e-3f2a9b8c7d10', w_in: 0.01, h_in: 0.01, dpi: 300,
  fit: 'cover', rotation: 0,
};

const image: LabelImage = { id: 'img-1', name: 'Cumulus', width: 600, height: 200, mime: 'image/png', created_at: '' };

/** Every request answers `resp`, but the session refresh. */
function answer(resp: () => Response) {
  const fetchMock = vi.fn(async (url: string | Request, _init?: RequestInit) => (String(url).endsWith('/auth/refresh')
    ? new Response(null, { status: 401 }) : resp()));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const call = (fetchMock: ReturnType<typeof answer>, path: string) =>
  fetchMock.mock.calls.find(([u]) => String(u).endsWith(path)) as unknown as [string, RequestInit];

it('posts the element and reads the gray bytes with their size', async () => {
  const fetchMock = answer(() => new Response(new Uint8Array([0, 128, 255, 9, 8, 7]), {
    status: 200, headers: { 'Content-Type': 'application/octet-stream', 'X-Raster-Width': '3', 'X-Raster-Height': '2' },
  }));
  const got = await labelImageRaster(BODY);
  expect(got).toEqual({ width: 3, height: 2, gray: new Uint8Array([0, 128, 255, 9, 8, 7]) });
  const [, init] = call(fetchMock, '/labels/images/raster');
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body as string)).toEqual(BODY);
});

it('leaves the size to the caller when the headers can’t be read', async () => {
  answer(() => new Response(new Uint8Array([1, 2]), { status: 200 }));
  expect(await labelImageRaster(BODY)).toEqual({ width: null, height: null, gray: new Uint8Array([1, 2]) });
});

it('no picture (404 no_image) is null; anything else refused is an ApiError', async () => {
  answer(() => new Response(JSON.stringify({ detail: { code: 'no_image' } }), { status: 404 }));
  expect(await labelImageRaster(BODY)).toBeNull();
  answer(() => new Response(JSON.stringify({ detail: { code: 'image_too_large' } }), { status: 422 }));
  await expect(labelImageRaster(BODY)).rejects.toMatchObject({ status: 422, code: 'image_too_large' });
  answer(() => new Response(JSON.stringify({ detail: { code: 'storage_unavailable' } }), { status: 502 }));
  await expect(labelImageRaster(BODY)).rejects.toBeInstanceOf(ApiError);
});

it('lists, uploads (multipart, the name optional) and deletes library images', async () => {
  let fetchMock = answer(() => new Response(JSON.stringify([image]), { status: 200 }));
  expect(await listLabelImages()).toEqual([image]);
  fetchMock = answer(() => new Response(JSON.stringify(image), { status: 201 }));
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'cumulus.png', { type: 'image/png' });
  expect(await uploadLabelImage(file, 'Cumulus')).toEqual(image);
  const [, init] = call(fetchMock, '/labels/images');
  expect(init.method).toBe('POST');
  expect((init.body as FormData).get('name')).toBe('Cumulus');
  expect(((init.body as FormData).get('file') as File).name).toBe('cumulus.png');
  fetchMock = answer(() => new Response(null, { status: 204 }));
  await deleteLabelImage('img-1');
  expect(call(fetchMock, '/labels/images/img-1')[1].method).toBe('DELETE');
});
