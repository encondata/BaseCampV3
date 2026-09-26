import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@portal/lib/api')>()),
  apiFetch: vi.fn(),
  refreshSystemStatus: vi.fn(),
}));

import { ApiError, apiFetch, READ_ONLY_MESSAGE, refreshSystemStatus } from '@portal/lib/api';

import {
  completeUpload,
  getAssetUrls,
  getPageContent,
  getSpaceGrants,
  getTree,
  listRecent,
  listSpaces,
  moveNode,
  publishPage,
  purgeTrash,
  search,
  searchPrincipals,
  setFavorite,
  updateSpace,
} from './wikiApi';

const fetchMock = vi.mocked(apiFetch);

function reply(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  });
}

function lastCall(): { path: string; init: RequestInit } {
  const [path, init] = fetchMock.mock.calls.at(-1)!;
  return { path, init: init ?? {} };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(refreshSystemStatus).mockReset();
});

describe('wikiApi requests', () => {
  it('prefixes /wiki and leaves out unset query parameters', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, []));
    await listSpaces();
    expect(lastCall().path).toBe('/wiki/spaces');

    fetchMock.mockResolvedValueOnce(reply(200, []));
    await listSpaces(true);
    expect(lastCall().path).toBe('/wiki/spaces?include_archived=true');

    fetchMock.mockResolvedValueOnce(reply(200, []));
    await listRecent({ limit: 5 });
    expect(lastCall().path).toBe('/wiki/recent?limit=5');
  });

  it('encodes path segments and query values', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, []));
    await getTree('ops/it', 'abc');
    expect(lastCall().path).toBe('/wiki/spaces/ops%2Fit/tree?parent_id=abc');

    fetchMock.mockResolvedValueOnce(reply(200, []));
    await search({ q: 'rack & pdu', space: 'ops', kind: 'page' });
    expect(lastCall().path).toBe('/wiki/search?q=rack+%26+pdu&space=ops&kind=page');

    fetchMock.mockResolvedValueOnce(reply(200, []));
    await searchPrincipals('person', 'ada');
    expect(lastCall().path).toBe('/wiki/principals?type=person&q=ada');
  });

  it('sends JSON bodies with the method', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { id: 's1' }));
    await updateSpace('ops', { name: 'Operations' });
    const { path, init } = lastCall();
    expect(path).toBe('/wiki/spaces/ops');
    expect(init.method).toBe('PATCH');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Operations' });

    fetchMock.mockResolvedValueOnce(reply(200, { id: 'n1' }));
    await moveNode('n1', { parent_id: null, after_id: 'n0' });
    expect(lastCall().path).toBe('/wiki/nodes/n1/move');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ parent_id: null, after_id: 'n0' });
  });

  it('reads page content as published unless told otherwise', async () => {
    fetchMock.mockResolvedValue(reply(200, { kind: 'published' }));
    await getPageContent('p1');
    expect(lastCall().path).toBe('/wiki/pages/p1/content?version=published');
    fetchMock.mockResolvedValue(reply(200, { kind: 'draft' }));
    await getPageContent('p1', 'draft');
    expect(lastCall().path).toBe('/wiki/pages/p1/content?version=draft');
  });

  it('returns the created row for 201 responses', async () => {
    fetchMock.mockResolvedValueOnce(reply(201, { id: 'v2', version_no: 2 }));
    await expect(publishPage('p1', 'First cut')).resolves.toEqual({ id: 'v2', version_no: 2 });
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ note: 'First cut' });

    fetchMock.mockResolvedValueOnce(reply(201, { id: 'a1', filename: 'x.png' }));
    await expect(completeUpload('u1')).resolves.toEqual({ id: 'a1', filename: 'x.png' });
  });

  it('resolves 204 responses to undefined', async () => {
    fetchMock.mockResolvedValueOnce(reply(204));
    await expect(purgeTrash('b1')).resolves.toBeUndefined();
    expect(lastCall()).toMatchObject({ path: '/wiki/trash/b1', init: { method: 'DELETE' } });

    fetchMock.mockResolvedValueOnce(reply(204));
    await setFavorite('n1', true);
    expect(lastCall()).toMatchObject({ path: '/wiki/nodes/n1/favorite', init: { method: 'PUT' } });

    fetchMock.mockResolvedValueOnce(reply(204));
    await setFavorite('n1', false);
    expect(lastCall().init.method).toBe('DELETE');
  });

  it('unwraps the grants and asset-url envelopes', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { grants: [{ id: 'g1' }] }));
    await expect(getSpaceGrants('ops')).resolves.toEqual([{ id: 'g1' }]);

    fetchMock.mockResolvedValueOnce(reply(200, { urls: { a1: 'https://s3/a1' } }));
    await expect(getAssetUrls(['a1', 'a2'])).resolves.toEqual({ a1: 'https://s3/a1' });
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ ids: ['a1', 'a2'] });
  });

  it('skips the request when asked for no asset urls', async () => {
    await expect(getAssetUrls([])).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('wikiApi errors', () => {
  it('throws the portal ApiError with the code and the server message', async () => {
    fetchMock.mockResolvedValueOnce(reply(409, {
      detail: { code: 'nothing_to_publish', message: 'Nothing changed since the last publish.' },
    }));
    const err = await publishPage('p1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      code: 'nothing_to_publish',
      message: 'Nothing changed since the last publish.',
    });
  });

  it('falls back to the code when the detail has no message', async () => {
    fetchMock.mockResolvedValueOnce(reply(404, { detail: { code: 'not_found' } }));
    await expect(getPageContent('p1')).rejects.toMatchObject({
      status: 404, code: 'not_found', message: 'not_found',
    });
  });

  it('reports validation errors and non-JSON bodies with a generic code', async () => {
    fetchMock.mockResolvedValueOnce(reply(422, { detail: [{ loc: ['body', 'title'] }] }));
    await expect(getPageContent('p1')).rejects.toMatchObject({ status: 422, code: 'unknown_error' });

    fetchMock.mockResolvedValueOnce(new Response('Bad gateway', { status: 502 }));
    await expect(getPageContent('p1')).rejects.toMatchObject({ status: 502, code: 'unknown_error' });
  });

  it('refreshes the system banners on read-only mode', async () => {
    fetchMock.mockResolvedValueOnce(reply(503, { detail: { code: 'read_only_mode' } }));
    await expect(publishPage('p1')).rejects.toMatchObject({
      code: 'read_only_mode', message: READ_ONLY_MESSAGE,
    });
    expect(refreshSystemStatus).toHaveBeenCalledTimes(1);
  });
});
