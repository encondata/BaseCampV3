// @vitest-environment jsdom
/** `getGeneratedLabelBundle` — the Print Labels page's label source, proven
 *  with the same low-level fetch-stubbing idiom as api.generateLabels.test.ts. */
import { afterEach, expect, it, vi } from 'vitest';

import { ApiError, getGeneratedLabelBundle, type GeneratedLabelBundle } from './api';

afterEach(() => vi.unstubAllGlobals());

const bundle: GeneratedLabelBundle = {
  initiative_id: 'i1', label_type: 'top', fetched_at: '2026-09-12T00:00:00Z',
  labels: [{
    id: 'g1', entity_type: 'asset', entity_id: 'a1', template_id: 't1', template_name: 'Top asset tag',
    template_version: 5, language_key: 'zpl', size_key: '4x2', dpi_key: '203', stale: false,
    generated_at: '2026-09-12T00:00:00Z', code: '^XA^XZ',
  }],
};

it('requests the bundle for the initiative + type and returns it', async () => {
  const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(bundle), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  const result = await getGeneratedLabelBundle('i1', 'top');

  expect(result).toEqual(bundle);
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/labels/generated/bundle'));
  expect(String(call?.[0])).toContain('/labels/generated/bundle?initiative_id=i1&label_type=top');
});

it('throws an ApiError on a non-OK response', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ detail: { code: 'initiative_not_found' } }), { status: 404 })));
  await expect(getGeneratedLabelBundle('nope', 'top')).rejects.toBeInstanceOf(ApiError);
});
