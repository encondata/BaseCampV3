// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { ApiError, deleteLabelFont, getLabelFontBytes, listLabelFonts, uploadLabelFont, type LabelFont } from './api';

afterEach(() => vi.unstubAllGlobals());

const font: LabelFont = {
  id: 'f1', name: '85620388.TTF', display_name: 'swiss.ttf', size_bytes: 1024, content_type: 'font/ttf',
  uploaded_by: 'p1', uploaded_by_name: 'Jimmy', created_at: '2026-09-12T00:00:00Z',
  used_by: [{ template_id: 't1', template_name: 'Front Asset Tag' }],
};

it('lists fonts', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([font]), { status: 200 })));
  expect(await listLabelFonts()).toEqual([font]);
});

it('uploads as multipart with the optional name', async () => {
  const fetchMock = vi.fn(async (_url: string | Request, _init?: RequestInit) => new Response(JSON.stringify(font), { status: 201 }));
  vi.stubGlobal('fetch', fetchMock);
  const file = new File([new Uint8Array([0, 1, 0, 0])], 'swiss.ttf', { type: 'font/ttf' });
  expect(await uploadLabelFont(file, '85620388.TTF')).toEqual(font);
  const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/labels/fonts'));
  const [url, init] = call as unknown as [string, RequestInit];
  expect(url).toContain('/labels/fonts');
  expect(init.method).toBe('POST');
  const body = init.body as FormData;
  expect(body.get('name')).toBe('85620388.TTF');
  expect((body.get('file') as File).name).toBe('swiss.ttf');
});

it('deletes and downloads bytes', async () => {
  const fetchMock = vi.fn(async (url: string) => String(url).endsWith('/content')
    ? new Response(new Uint8Array([0, 1, 0, 0, 9]), { status: 200 })
    : new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  await deleteLabelFont('f1');
  const deleteCall = String(fetchMock.mock.calls.find(([u]) => String(u).includes('/labels/fonts/f1'))?.[0]);
  expect(deleteCall).toContain('/labels/fonts/f1');
  const bytes = await getLabelFontBytes('f1');
  expect(Array.from(bytes)).toEqual([0, 1, 0, 0, 9]);
});

it('surfaces API errors', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: { code: 'font_name_taken' } }), { status: 409 })));
  await expect(uploadLabelFont(new File([''], 'x.ttf'))).rejects.toBeInstanceOf(ApiError);
});
