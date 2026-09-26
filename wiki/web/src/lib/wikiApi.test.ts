import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@portal/lib/api')>()),
  apiFetch: vi.fn(),
  refreshSystemStatus: vi.fn(),
}));

import { ApiError, apiFetch, READ_ONLY_MESSAGE, refreshSystemStatus } from '@portal/lib/api';

import {
  approveReview,
  completeUpload,
  createNode,
  createExport,
  createShareLink,
  createTemplate,
  deleteComment,
  deleteTemplate,
  editComment,
  getTemplate,
  getReview,
  getWatchState,
  getAnalytics,
  getExport,
  getAssetUrls,
  getMyFeedback,
  getPageContent,
  getSpaceGrants,
  getTree,
  listComments,
  listDueReviews,
  listMentionable,
  listRecent,
  listAllShareLinks,
  listReviews,
  listShareLinks,
  listSpaces,
  listTemplates,
  listWatches,
  markReviewed,
  moveNode,
  postComment,
  publishPage,
  purgeTrash,
  putFeedback,
  recordView,
  rejectReview,
  putDraft,
  reopenThread,
  resolveThread,
  revokeShareLink,
  search,
  searchPrincipals,
  setFavorite,
  submitReview,
  unwatch,
  updateSpace,
  updateTemplate,
  watch,
  withdrawReview,
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

    const doc = { type: 'doc', content: [{ type: 'paragraph' }] };
    fetchMock.mockResolvedValueOnce(reply(204));
    await expect(putDraft('p1', doc)).resolves.toBeUndefined();
    expect(lastCall()).toMatchObject({ path: '/wiki/nodes/p1/draft', init: { method: 'PUT' } });
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ content_json: doc });
  });

  it('lists, adds and removes watches and reads a node\'s watch state', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, []));
    await expect(listWatches()).resolves.toEqual([]);
    expect(lastCall()).toMatchObject({ path: '/wiki/watches', init: {} });

    const out = { id: 'w1', node: { id: 'n1', title: 'Runbook', kind: 'page' },
      space: { key: 'ops', name: 'Ops' }, created_at: '2026-09-26T00:00:00Z' };
    fetchMock.mockResolvedValueOnce(reply(200, out));
    await expect(watch({ node_id: 'n1' })).resolves.toEqual(out);
    expect(lastCall()).toMatchObject({ path: '/wiki/watches', init: { method: 'PUT' } });
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ node_id: 'n1' });

    fetchMock.mockResolvedValueOnce(reply(200, { ...out, node: null }));
    await watch({ space_id: 's1' });
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ space_id: 's1' });

    fetchMock.mockResolvedValueOnce(reply(204));
    await expect(unwatch('w1')).resolves.toBeUndefined();
    expect(lastCall()).toMatchObject({ path: '/wiki/watches/w1', init: { method: 'DELETE' } });

    const state = { watching: true, via: 'ancestor', watch_id: 'w2' };
    fetchMock.mockResolvedValueOnce(reply(200, state));
    await expect(getWatchState('n1')).resolves.toEqual(state);
    expect(lastCall().path).toBe('/wiki/nodes/n1/watch');
  });

  it('submits, lists, reads and decides reviews; marks pages reviewed; lists due reviews', async () => {
    const review = { id: 'r1', node: { id: 'p1', title: 'Runbook', space_key: 'ops', space_name: 'Ops' },
      version_id: 'v1', status: 'pending', note: '', requested_by: null,
      created_at: '2026-09-26T00:00:00Z', decided_by: null, decided_at: null, decision_note: '' };
    const body = () => JSON.parse(String(lastCall().init.body));

    fetchMock.mockResolvedValueOnce(reply(201, review));
    await expect(submitReview('p1', 'Ready')).resolves.toEqual(review);
    expect(lastCall()).toMatchObject({ path: '/wiki/pages/p1/reviews', init: { method: 'POST' } });
    expect(body()).toEqual({ note: 'Ready' });
    fetchMock.mockResolvedValueOnce(reply(201, review));
    await submitReview('p1');
    expect(body()).toEqual({});

    fetchMock.mockResolvedValueOnce(reply(200, [review]));
    await expect(listReviews({ mine: 'approver' })).resolves.toEqual([review]);
    expect(lastCall().path).toBe('/wiki/reviews?mine=approver');
    fetchMock.mockResolvedValueOnce(reply(200, []));
    await listReviews();
    expect(lastCall().path).toBe('/wiki/reviews');
    fetchMock.mockResolvedValueOnce(reply(200, []));
    await listReviews({ status: 'approved', mine: 'requester' });
    expect(lastCall().path).toBe('/wiki/reviews?status=approved&mine=requester');

    fetchMock.mockResolvedValueOnce(reply(200, { ...review, submitted_version_no: 2 }));
    await getReview('r1');
    expect(lastCall().path).toBe('/wiki/reviews/r1');

    fetchMock.mockResolvedValueOnce(reply(200, { ...review, status: 'approved' }));
    await approveReview('r1', 'Nice');
    expect(lastCall()).toMatchObject({ path: '/wiki/reviews/r1/approve', init: { method: 'POST' } });
    expect(body()).toEqual({ note: 'Nice' });

    fetchMock.mockResolvedValueOnce(reply(200, { ...review, status: 'rejected' }));
    await rejectReview('r1', 'Fix step 3');
    expect(lastCall().path).toBe('/wiki/reviews/r1/reject');
    expect(body()).toEqual({ note: 'Fix step 3' });

    fetchMock.mockResolvedValueOnce(reply(200, { ...review, status: 'withdrawn' }));
    await withdrawReview('r1');
    expect(lastCall()).toMatchObject({ path: '/wiki/reviews/r1/withdraw', init: { method: 'POST' } });

    fetchMock.mockResolvedValueOnce(reply(409, { detail: { code: 'not_pending', message: 'Already decided.' } }));
    await expect(approveReview('r1')).rejects.toMatchObject({ status: 409, code: 'not_pending' });

    fetchMock.mockResolvedValueOnce(reply(200, {}));
    await markReviewed('p1');
    expect(lastCall()).toMatchObject({ path: '/wiki/pages/p1/mark-reviewed', init: { method: 'POST' } });

    fetchMock.mockResolvedValueOnce(reply(200, []));
    await expect(listDueReviews('ops')).resolves.toEqual([]);
    expect(lastCall().path).toBe('/wiki/spaces/ops/due-reviews');
  });

  it('reads, posts, edits, deletes and resolves comments; finds mentionable people', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, []));
    await expect(listComments('n1')).resolves.toEqual([]);
    expect(lastCall()).toMatchObject({ path: '/wiki/nodes/n1/comments', init: {} });

    const comment = { id: 'c1', thread_id: 'c1', parent_id: null,
      body: { text: 'hi @Pat', mentions: [{ id: 'p1', name: 'Pat' }] }, author: null,
      created_at: '2026-09-26T00:00:00Z', edited_at: null, deleted: false };
    fetchMock.mockResolvedValueOnce(reply(201, comment));
    await expect(postComment('n1', { body: { text: 'hi @Pat', mentions: ['p1'] },
      thread_id: 't1' })).resolves.toEqual(comment);
    expect(lastCall()).toMatchObject({ path: '/wiki/nodes/n1/comments', init: { method: 'POST' } });
    expect(JSON.parse(String(lastCall().init.body))).toEqual(
      { body: { text: 'hi @Pat', mentions: ['p1'] }, thread_id: 't1' });

    fetchMock.mockResolvedValueOnce(reply(200, comment));
    await editComment('c1', { text: 'edited', mentions: [] });
    expect(lastCall()).toMatchObject({ path: '/wiki/comments/c1', init: { method: 'PATCH' } });
    expect(JSON.parse(String(lastCall().init.body))).toEqual(
      { body: { text: 'edited', mentions: [] } });

    fetchMock.mockResolvedValueOnce(reply(204));
    await expect(deleteComment('c1')).resolves.toBeUndefined();
    expect(lastCall()).toMatchObject({ path: '/wiki/comments/c1', init: { method: 'DELETE' } });

    const thread = { thread_id: 'c1', anchor: true, resolved_at: null, resolved_by: null,
      comments: [comment] };
    fetchMock.mockResolvedValueOnce(reply(200, thread));
    await expect(resolveThread('c1')).resolves.toEqual(thread);
    expect(lastCall()).toMatchObject(
      { path: '/wiki/comments/threads/c1/resolve', init: { method: 'POST' } });
    fetchMock.mockResolvedValueOnce(reply(200, thread));
    await reopenThread('c1');
    expect(lastCall().path).toBe('/wiki/comments/threads/c1/reopen');

    fetchMock.mockResolvedValueOnce(reply(200, [{ id: 'p1', name: 'Pat' }]));
    await expect(listMentionable('n1', 'pa t')).resolves.toEqual([{ id: 'p1', name: 'Pat' }]);
    expect(lastCall().path).toBe('/wiki/nodes/n1/mentionable?q=pa+t');
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

  it('lists, reads, creates, updates and deletes templates', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, []));
    await expect(listTemplates()).resolves.toEqual([]);
    expect(lastCall().path).toBe('/wiki/templates');

    fetchMock.mockResolvedValueOnce(reply(200, []));
    await listTemplates('ops');
    expect(lastCall().path).toBe('/wiki/templates?space=ops');

    const detail = { id: 't1', space_id: null, space_key: null, name: 'SOP',
      description: '', icon: '', is_builtin: true, created_by: null,
      created_at: '2026-09-26T00:00:00Z', updated_at: '2026-09-26T00:00:00Z',
      content_json: { type: 'doc', content: [] } };
    fetchMock.mockResolvedValueOnce(reply(200, detail));
    await expect(getTemplate('t1')).resolves.toEqual(detail);
    expect(lastCall().path).toBe('/wiki/templates/t1');

    fetchMock.mockResolvedValueOnce(reply(201, { ...detail, is_builtin: false }));
    await createTemplate({ space_id: 'ops', name: 'Runbook',
      content_json: { type: 'doc', content: [] } });
    expect(lastCall()).toMatchObject({ path: '/wiki/templates', init: { method: 'POST' } });
    expect(JSON.parse(String(lastCall().init.body))).toEqual(
      { space_id: 'ops', name: 'Runbook', content_json: { type: 'doc', content: [] } });

    fetchMock.mockResolvedValueOnce(reply(201, { ...detail, is_builtin: false }));
    await createTemplate({ name: 'From a page', from_node_id: 'n1' });
    expect(JSON.parse(String(lastCall().init.body))).toEqual(
      { name: 'From a page', from_node_id: 'n1' });

    fetchMock.mockResolvedValueOnce(reply(200, { ...detail, name: 'Renamed' }));
    await updateTemplate('t1', { name: 'Renamed' });
    expect(lastCall()).toMatchObject({ path: '/wiki/templates/t1', init: { method: 'PATCH' } });

    const editedContent = { type: 'doc', content: [{ type: 'paragraph' }] };
    fetchMock.mockResolvedValueOnce(reply(200, { ...detail, content_json: editedContent }));
    await updateTemplate('t1', { content_json: editedContent });
    expect(lastCall()).toMatchObject({ path: '/wiki/templates/t1', init: { method: 'PATCH' } });
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ content_json: editedContent });

    fetchMock.mockResolvedValueOnce(reply(204));
    await expect(deleteTemplate('t1')).resolves.toBeUndefined();
    expect(lastCall()).toMatchObject({ path: '/wiki/templates/t1', init: { method: 'DELETE' } });
  });

  it('creates a node from a template, leaving out an unset title', async () => {
    fetchMock.mockResolvedValueOnce(reply(201, { id: 'n2' }));
    await createNode({ space_id: 's1', parent_id: null, kind: 'page', template_id: 'tmpl1' });
    expect(JSON.parse(String(lastCall().init.body))).toEqual(
      { space_id: 's1', parent_id: null, kind: 'page', template_id: 'tmpl1' });
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

describe('share links', () => {
  it('creates a link with an expiry (or none), lists, revokes, and lists every link', async () => {
    fetchMock.mockResolvedValueOnce(reply(201, { id: 'l1', url: 'https://wiki/p/t', expires_at: null }));
    await createShareLink('n1', 7);
    expect(lastCall().path).toBe('/wiki/nodes/n1/share-links');
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ expires_in_days: 7 });

    fetchMock.mockResolvedValueOnce(reply(201, { id: 'l2', url: 'https://wiki/p/u', expires_at: null }));
    await createShareLink('n1', null);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ expires_in_days: null });

    fetchMock.mockResolvedValueOnce(reply(200, []));
    await listShareLinks('n1');
    expect(lastCall().path).toBe('/wiki/nodes/n1/share-links');

    fetchMock.mockResolvedValueOnce(reply(204));
    await revokeShareLink('l1');
    expect(lastCall().path).toBe('/wiki/share-links/l1');
    expect(lastCall().init.method).toBe('DELETE');

    fetchMock.mockResolvedValueOnce(reply(200, []));
    await listAllShareLinks();
    expect(lastCall().path).toBe('/wiki/share-links');
  });
});

describe('exports', () => {
  it('queues an export and reads it back', async () => {
    fetchMock.mockResolvedValueOnce(reply(202, { job_id: 'j1' }));
    await createExport({ node_id: 'n1', format: 'zip', zip_format: 'md' });
    expect(lastCall().path).toBe('/wiki/exports');
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ node_id: 'n1', format: 'zip', zip_format: 'md' });

    fetchMock.mockResolvedValueOnce(reply(200, { id: 'j1', status: 'queued' }));
    await getExport('j/1');
    expect(lastCall().path).toBe('/wiki/exports/j%2F1');
  });
});

describe('analytics', () => {
  it('records a view, saves and reads feedback, and reads the analytics', async () => {
    fetchMock.mockResolvedValueOnce(reply(204));
    await recordView('n1');
    expect(lastCall().path).toBe('/wiki/nodes/n1/view');
    expect(lastCall().init.method).toBe('POST');

    fetchMock.mockResolvedValueOnce(reply(200, { helpful: false, comment: 'Old', updated_at: 'x' }));
    await putFeedback('p1', { helpful: false, comment: 'Old' });
    expect(lastCall().path).toBe('/wiki/pages/p1/feedback');
    expect(lastCall().init.method).toBe('PUT');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ helpful: false, comment: 'Old' });

    fetchMock.mockResolvedValueOnce(reply(200, { helpful: true, comment: null, updated_at: 'x' }));
    await getMyFeedback('p1');
    expect(lastCall().path).toBe('/wiki/pages/p1/feedback/mine');

    fetchMock.mockResolvedValueOnce(reply(200, {}));
    await getAnalytics({ space: 'ops', days: 90 });
    expect(lastCall().path).toBe('/wiki/analytics?space=ops&days=90');
    fetchMock.mockResolvedValueOnce(reply(200, {}));
    await getAnalytics({ days: 30 });
    expect(lastCall().path).toBe('/wiki/analytics?days=30');
  });

  it('asks the search not to be logged when told to', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, []));
    await search({ q: 'rack', limit: 8, log: false });
    expect(lastCall().path).toBe('/wiki/search?q=rack&limit=8&log=false');
    fetchMock.mockResolvedValueOnce(reply(200, []));
    await search({ q: 'rack' });
    expect(lastCall().path).toBe('/wiki/search?q=rack');
  });
});
