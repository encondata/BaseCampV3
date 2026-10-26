// @vitest-environment jsdom
/** The typed /learning client: every route's method, path, query and body,
 *  error mapping, the PDF downloads, and the compliance report export. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import * as L from './learning';

const SESSION = {
  status: 'ok', access_token: 'tok', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z',
  person: { id: 'p1' }, roles: [], must_change_password: false, preferences: {},
  perms: {}, max_rank: 0, scope: { global: true, client_ids: [], partner_ids: [] },
  password_min_length: 8,
  totp: { enrolled: false, enrolled_at: null, required: false, backup_codes_remaining: 0 },
};

type Call = { path: string; query: URLSearchParams; method: string; body: unknown };

/** apiFetch refreshes first (no token yet): answer that, give every other
 *  call `answer`, and return the non-refresh calls, parsed. */
function mockFetch(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/auth/refresh')) {
      return new Response(JSON.stringify(SESSION), { status: 200 });
    }
    const u = new URL(url);
    const call: Call = {
      path: u.pathname.replace(/^.*?(\/(learning|system|reports)\/)/, '/$2/'),
      query: u.searchParams, method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return answer(call);
  }));
  return calls;
}

const ok = (body: unknown = {}, status = 200) => () => (status === 204
  ? new Response(null, { status })
  : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

const ID = 'doc-1';

// [name, invoke, method, path, query, body]
const CASES: [string, () => Promise<unknown>, string, string, string, unknown][] = [
  ['listDocuments', () => L.listLearningDocuments(), 'GET', '/learning/documents', '', undefined],
  ['listDocuments archived', () => L.listLearningDocuments(true), 'GET', '/learning/documents', 'include_archived=true', undefined],
  ['createDocument', () => L.createLearningDocument({ title: 'T', wiki_node_id: 'n1' }), 'POST', '/learning/documents', '', { title: 'T', wiki_node_id: 'n1' }],
  ['getDocument', () => L.getLearningDocument(ID), 'GET', `/learning/documents/${ID}`, '', undefined],
  ['patchDocument', () => L.patchLearningDocument(ID, { quiz_enabled: true, quiz_pass_percent: 80 }), 'PATCH', `/learning/documents/${ID}`, '', { quiz_enabled: true, quiz_pass_percent: 80 }],
  ['publishDocument', () => L.publishLearningDocument(ID, 'Fixed typos'), 'POST', `/learning/documents/${ID}/publish`, '', { change_note: 'Fixed typos' }],
  ['publishDocument no note', () => L.publishLearningDocument(ID), 'POST', `/learning/documents/${ID}/publish`, '', {}],
  ['getVersion', () => L.getLearningVersion(ID, 'v1'), 'GET', `/learning/documents/${ID}/versions/v1`, '', undefined],
  ['signoffs', () => L.listDocumentSignoffs(ID), 'GET', `/learning/documents/${ID}/signoffs`, '', undefined],
  ['signoffs paged', () => L.listDocumentSignoffs(ID, { limit: 50, offset: 100, versionId: 'v1' }), 'GET', `/learning/documents/${ID}/signoffs`, 'limit=50&offset=100&version_id=v1', undefined],
  ['archiveDocument', () => L.archiveLearningDocument(ID), 'DELETE', `/learning/documents/${ID}`, '', undefined],
  ['wikiPages', () => L.listLearningWikiPages(), 'GET', '/learning/wiki-pages', '', undefined],
  ['listPackets', () => L.listLearningPackets(), 'GET', '/learning/packets', '', undefined],
  ['listPackets archived', () => L.listLearningPackets(true), 'GET', '/learning/packets', 'include_archived=true', undefined],
  ['createPacket', () => L.createLearningPacket({ name: 'P', items: ['d1'] }), 'POST', '/learning/packets', '', { name: 'P', items: ['d1'] }],
  ['getPacket', () => L.getLearningPacket('k1'), 'GET', '/learning/packets/k1', '', undefined],
  ['patchPacket', () => L.patchLearningPacket('k1', { items: ['d2', 'd1'] }), 'PATCH', '/learning/packets/k1', '', { items: ['d2', 'd1'] }],
  ['copyPacket', () => L.copyLearningPacket('k1'), 'POST', '/learning/packets/k1/copy', '', undefined],
  ['archivePacket', () => L.archiveLearningPacket('k1'), 'DELETE', '/learning/packets/k1', '', undefined],
  ['listRules', () => L.listLearningRules(), 'GET', '/learning/rules', '', undefined],
  ['createRule', () => L.createLearningRule({ name: 'R', packet_id: 'k1', conditions: [{ field: 'trade', values: ['x'] }] }), 'POST', '/learning/rules', '', { name: 'R', packet_id: 'k1', conditions: [{ field: 'trade', values: ['x'] }] }],
  ['patchRule', () => L.patchLearningRule('r1', { enabled: false }), 'PATCH', '/learning/rules/r1', '', { enabled: false }],
  ['deleteRule', () => L.deleteLearningRule('r1'), 'DELETE', '/learning/rules/r1', '', undefined],
  ['reorderRules', () => L.reorderLearningRules(['r2', 'r1']), 'POST', '/learning/rules/reorder', '', { ids: ['r2', 'r1'] }],
  ['initiativeSummary', () => L.getInitiativeLearning('i1'), 'GET', '/learning/initiatives/i1', '', undefined],
  ['putSchedule', () => L.putInitiativeSchedule('i1', { mode: 'scheduled', send_time: '08:00' }), 'PUT', '/learning/initiatives/i1/schedule', '', { mode: 'scheduled', send_time: '08:00' }],
  ['sendInvites all', () => L.sendInitiativeInvites('i1'), 'POST', '/learning/initiatives/i1/send', '', {}],
  ['sendInvites some', () => L.sendInitiativeInvites('i1', ['a', 'b']), 'POST', '/learning/initiatives/i1/send', '', { person_ids: ['a', 'b'] }],
  ['roster', () => L.listInitiativeRoster('i1'), 'GET', '/learning/initiatives/i1/roster', '', undefined],
  ['roster filtered', () => L.listInitiativeRoster('i1', 'overdue'), 'GET', '/learning/initiatives/i1/roster', 'status=overdue', undefined],
  ['dryRun', () => L.dryRunInitiative('i1'), 'POST', '/learning/initiatives/i1/dry-run', '', { apply: false }],
  ['dryRun apply', () => L.dryRunInitiative('i1', true), 'POST', '/learning/initiatives/i1/dry-run', '', { apply: true }],
  ['regenerate', () => L.regenerateLearningCode('i1', 'p9'), 'POST', '/learning/initiatives/i1/people/p9/regenerate', '', undefined],
  ['revoke', () => L.revokeLearningCodes('i1', 'p9'), 'POST', '/learning/initiatives/i1/people/p9/revoke', '', undefined],
  ['grid', () => L.getInitiativeGrid('i1'), 'GET', '/learning/initiatives/i1/grid', '', undefined],
  ['assign', () => L.assignLearning({ person_ids: ['p1'], packet_id: 'k1' }), 'POST', '/learning/assign', '', { person_ids: ['p1'], packet_id: 'k1' }],
  ['pushVersion', () => L.pushLearningVersion(ID, ['p1']), 'POST', `/learning/documents/${ID}/push-version`, '', { person_ids: ['p1'] }],
  ['listTranslations', () => L.listTranslations(ID), 'GET', `/learning/documents/${ID}/translations`, '', undefined],
  ['getTranslation', () => L.getTranslation(ID, 'pt-BR'), 'GET', `/learning/documents/${ID}/translations/pt-BR`, '', undefined],
  ['saveTranslation', () => L.saveTranslation(ID, 'ja', { title: 'タイトル', content_html: '<p>x</p>' }), 'PUT', `/learning/documents/${ID}/translations/ja`, '', { title: 'タイトル', content_html: '<p>x</p>' }],
  ['draftTranslation', () => L.draftTranslation(ID, 'ko'), 'POST', `/learning/documents/${ID}/translations/ko/draft`, '', undefined],
  ['submitTranslation', () => L.submitTranslation(ID, 'ko'), 'POST', `/learning/documents/${ID}/translations/ko/submit`, '', undefined],
  ['approveTranslation', () => L.approveTranslation(ID, 'he'), 'POST', `/learning/documents/${ID}/translations/he/approve`, '', undefined],
  ['listQuestions', () => L.listQuestions(ID), 'GET', `/learning/documents/${ID}/questions`, '', undefined],
  ['createQuestion', () => L.createQuestion(ID, { prompt: 'Q?', choices: [{ text: 'a' }, { text: 'b' }], correct_choice_ids: ['a'] }), 'POST', `/learning/documents/${ID}/questions`, '', { prompt: 'Q?', choices: [{ text: 'a' }, { text: 'b' }], correct_choice_ids: ['a'] }],
  ['reorderQuestions', () => L.reorderQuestions(ID, ['q2', 'q1']), 'POST', `/learning/documents/${ID}/questions/reorder`, '', { ids: ['q2', 'q1'] }],
  ['patchQuestion', () => L.patchQuestion('q1', { prompt: 'New?' }), 'PATCH', '/learning/questions/q1', '', { prompt: 'New?' }],
  ['deleteQuestion', () => L.deleteQuestion('q1'), 'DELETE', '/learning/questions/q1', '', undefined],
  ['unlockQuiz', () => L.unlockQuiz('a1'), 'POST', '/learning/assignments/a1/unlock-quiz', '', undefined],
  ['dashboard', () => L.getLearningDashboard(7), 'GET', '/learning/dashboard', 'days=7', undefined],
  ['dashboard default', () => L.getLearningDashboard(), 'GET', '/learning/dashboard', 'days=30', undefined],
  ['history', () => L.getLearningHistory('p1'), 'GET', '/learning/people/p1/history', '', undefined],
  ['getSettings', () => L.getLearningSettings(), 'GET', '/system/learning', '', undefined],
  ['putSettings', () => L.putLearningSettings({ general_code_days: null, due_offset_days: 3 }), 'PUT', '/system/learning', '', { general_code_days: null, due_offset_days: 3 }],
];

it.each(CASES)('%s', async (_name, invoke, method, path, query, body) => {
  const calls = mockFetch(ok(method === 'DELETE' ? undefined : {}, method === 'DELETE' ? 204 : 200));
  await invoke();
  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe(method);
  expect(calls[0].path).toBe(path);
  expect(calls[0].query.toString()).toBe(query);
  expect(calls[0].body).toEqual(body);
});

it('encodes path segments', async () => {
  const calls = mockFetch(ok({}));
  await L.getTranslation('d 1', 'a/b');
  expect(calls[0].path).toBe('/learning/documents/d%201/translations/a%2Fb');
});

it('returns the parsed body', async () => {
  mockFetch(ok([{ id: 'd1', title: 'T' }]));
  expect(await L.listLearningDocuments()).toEqual([{ id: 'd1', title: 'T' }]);
});

it('throws ApiError carrying status, code and detail', async () => {
  mockFetch(() => new Response(JSON.stringify({ detail: { code: 'no_email', message: 'No email' } }), { status: 422 }));
  const err = await L.regenerateLearningCode('i1', 'p1').catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(422);
  expect(err.code).toBe('no_email');
});

it('downloads the code sheet, with the all flag', async () => {
  const calls = mockFetch(() => new Response('%PDF', { status: 200 }));
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await L.downloadCodeSheet('i1', true);
  await L.downloadCodeSheet('i1');
  expect(calls[0].path).toBe('/learning/initiatives/i1/code-sheet.pdf');
  expect(calls[0].query.get('all')).toBe('1');
  expect(calls[1].query.has('all')).toBe(false);
  expect(click).toHaveBeenCalledTimes(2);
});

it('downloads a certificate, optionally for one initiative', async () => {
  const calls = mockFetch(() => new Response('%PDF', { status: 200 }));
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await L.downloadCertificate('p1', 'Maria Santos', 'i1');
  expect(calls[0].path).toBe('/learning/people/p1/certificate.pdf');
  expect(calls[0].query.get('initiative_id')).toBe('i1');
});

it('exports the compliance report for everyone, notifying when ready', async () => {
  const calls = mockFetch(({ path, method }) => {
    if (path === '/reports/definitions') {
      return new Response(JSON.stringify([
        { id: 'd-other', report_type: 'move_report' },
        { id: 'd-learn', report_type: 'learning_compliance' },
      ]), { status: 200 });
    }
    expect(method).toBe('POST');
    return new Response(JSON.stringify({ id: 'run-1' }), { status: 201 });
  });
  const run = await L.exportLearningCompliance();
  expect(run).toEqual({ id: 'run-1' });
  expect(calls[1].path).toBe('/reports/runs');
  expect(calls[1].body).toEqual({
    definition_id: 'd-learn', initiative_id: null, options: {}, notify: true,
  });
});

it('reports a missing compliance definition', async () => {
  mockFetch(ok([]));
  await expect(L.exportLearningCompliance()).rejects.toThrow('learning_report_missing');
});

it('formats a median in minutes or hours', () => {
  expect(L.formatMedianHours(null)).toBeNull();
  expect(L.formatMedianHours(0.5)).toBe('30 min');
  expect(L.formatMedianHours(6)).toBe('6 h');
  expect(L.formatMedianHours(6.4)).toBe('6.4 h');
  expect(L.formatMedianHours(30)).toBe('30 h');
});
