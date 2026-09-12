// @vitest-environment jsdom
/**
 * `listGeneratedLabels` has no caller yet in the portal — the spec
 * documents it as "the building block the future Print page and other
 * callers use" (Print Labels is explicitly out of scope for this phase).
 * This exercises it directly, the same low-level `fetch`-stubbing idiom
 * as `api.readonly.test.ts`, so the function stays proven rather than
 * dead weight nobody's watching.
 */
import { afterEach, expect, it, vi } from 'vitest';

import { listGeneratedLabels, type GeneratedLabel } from './api';

afterEach(() => vi.unstubAllGlobals());

it('builds the query string from every param and returns the parsed rows', async () => {
  const rows: GeneratedLabel[] = [{
    id: 'g1', entity_type: 'asset', entity_id: 'a1', asset_id: 1, serial_number: 'SN1',
    name: 'Asset 1', label_type: 'top', template_name: 'Top asset tag', template_version: 5,
    generated_at: '2026-09-11T00:00:00Z', stale: false, code: '^XA^XZ',
  }];
  const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(rows), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  const result = await listGeneratedLabels({ initiative_id: 'i1', label_type: 'top', limit: 10 });

  expect(result).toEqual(rows);
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/labels/generated'));
  expect(call).toBeDefined();
  const url = String(call?.[0]);
  expect(url).toContain('/labels/generated?');
  expect(url).toContain('initiative_id=i1');
  expect(url).toContain('label_type=top');
  expect(url).toContain('limit=10');
});

it('omits params that were not passed', async () => {
  const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('[]', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  await listGeneratedLabels();

  const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/labels/generated'));
  expect(String(call?.[0])).toMatch(/\/labels\/generated$/);
});
