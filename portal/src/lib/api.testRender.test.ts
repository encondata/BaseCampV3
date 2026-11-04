// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { ApiError, renderTestLabel } from './api';

afterEach(() => vi.unstubAllGlobals());

it('posts exactly the template id and DPI, and returns the ZPL and name', async () => {
  const fetchMock = vi.fn(async (_url: string | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ zpl: '^XA^FDsample^FS^XZ', template_name: 'Front Tag' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  expect(await renderTestLabel('t1', '203')).toEqual({ zpl: '^XA^FDsample^FS^XZ', template_name: 'Front Tag' });
  const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/labels/test-render'));
  const [url, init] = call as unknown as [string, RequestInit];
  expect(url).toContain('/labels/test-render');
  expect(init.method).toBe('POST');
  // the API refuses any other key (a 422 list), so the body is exactly these two
  expect(JSON.parse(String(init.body))).toEqual({ template_id: 't1', dpi_key: '203' });
});

it('throws an ApiError carrying the API code', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ detail: { code: 'template_unconvertible' } }), { status: 422 })));
  const err = await renderTestLabel('t1', '203').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe('template_unconvertible');
});
