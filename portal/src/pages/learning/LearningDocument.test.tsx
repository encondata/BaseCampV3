// @vitest-environment jsdom
/**
 * /learning/library/:documentId — the header (version chip, Preview as worker,
 * Edit in wiki, Publish), the ?tab= tabs, and the Content and rules panel:
 * every rule autosaves as a PATCH of just that field with a toast, the re-sign
 * rule is two option cards, and a manager with view only sees the same values
 * as read-only text. The publish modal sends the change note.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { LearningDocument as Doc } from '../../lib/learning';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const auth = vi.hoisted(() => ({
  perms: { view: true, add: true, change: true, delete: true } as Record<string, boolean>,
}));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string, action = 'view') => resource === 'learning' && auth.perms[action] === true,
    scope: { global: true },
    preferences: {},
    updatePreferences: vi.fn(),
    hasRole: () => false,
    person: { id: 'me', display_name: 'Me' },
  }),
}));

const api = vi.hoisted(() => ({
  getLearningDocument: vi.fn(),
  patchLearningDocument: vi.fn(),
  publishLearningDocument: vi.fn(),
  archiveLearningDocument: vi.fn(),
  getLearningVersion: vi.fn(),
  listTranslations: vi.fn(),
  getTranslation: vi.fn(),
  listDocumentSignoffs: vi.fn(),
  listQuestions: vi.fn(),
}));
vi.mock('../../lib/learning', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/learning')>()),
  ...api,
}));

const { default: LearningDocument } = await import('./LearningDocument');

const DOC: Doc = {
  id: 'd1', title: 'Dress code', summary: 'What to wear on every client site.',
  validity_days: 365, resign_rule: 'expired_or_new_version', sign_style: 'typed_name',
  require_scroll: true, min_read_seconds: 60, quiz_enabled: false,
  quiz_pass_percent: null, quiz_max_attempts: null, quiz_fail_action: 'retry',
  wiki_node_id: 'w1',
  wiki_page: { id: 'w1', title: 'Dress code', published_version_no: 5 },
  has_wiki_changes: true,
  current_version_id: 'v4', current_version_no: 4,
  current_html: '<h4>Every day on site</h4><p>Company shirt, tucked in.</p>',
  versions: [
    { id: 'v4', version_no: 4, wiki_version_no: 9, title: 'Dress code', change_note: 'Added ESD wrist strap rule',
      published_at: '2026-10-12T15:00:00Z', published_by: { id: 'p1', name: 'Jimmy Henderson' } },
    { id: 'v3', version_no: 3, wiki_version_no: 7, title: 'Dress code', change_note: 'Safety shoe wording',
      published_at: '2026-06-02T15:00:00Z', published_by: { id: 'p2', name: 'Laura Chen' } },
  ],
  archived_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-12T15:00:00Z',
};

const TRANSLATIONS = [
  { language: 'ja', status: 'published', version_no: 4, updated_at: '2026-10-13T00:00:00Z', reviewed_by: null },
  { language: 'ko', status: 'in_review', version_no: 4, updated_at: '2026-10-13T00:00:00Z', reviewed_by: null },
  { language: 'he', status: 'out_of_date', version_no: 3, updated_at: '2026-06-03T00:00:00Z', reviewed_by: null },
];

function renderPage(path = '/learning/library/d1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/learning/library/:documentId" element={<LearningDocument />} />
        <Route path="/learning/library" element={<div>Library page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.perms = { view: true, add: true, change: true, delete: true };
  api.getLearningDocument.mockReset().mockResolvedValue(DOC);
  api.patchLearningDocument.mockReset().mockImplementation(async (_id: string, patch: object) => ({ ...DOC, ...patch }));
  api.publishLearningDocument.mockReset().mockResolvedValue({ ...DOC.versions[0], id: 'v5', version_no: 5, html: '' });
  api.archiveLearningDocument.mockReset().mockResolvedValue(undefined);
  api.getLearningVersion.mockReset().mockResolvedValue({ ...DOC.versions[1], html: '<p>Old shoe wording</p>' });
  api.listTranslations.mockReset().mockResolvedValue(TRANSLATIONS);
  api.getTranslation.mockReset().mockResolvedValue({
    language: 'ja', status: 'published', version_no: 4, current_version_no: 4, title: '服装規定',
    content_html: '<p>作業服</p>', source: 'manual', updated_at: '2026-10-13T00:00:00Z',
    updated_by: null, reviewed_by: null, reviewed_at: null,
  });
  api.listDocumentSignoffs.mockReset().mockResolvedValue({
    total: 312, version_counts: { v4: 300, v3: 12 }, items: [],
  });
  api.listQuestions.mockReset().mockResolvedValue([]);
  toast.mockReset();
});
afterEach(cleanup);

const ready = () => screen.findByRole('heading', { level: 1, name: /Dress code/ });

it('shows the version chip, tab counts and the rendered content', async () => {
  renderPage();
  await ready();
  expect(screen.getByText('v4 published')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Preview as worker/ })).toBeTruthy();
  expect(screen.getByRole('link', { name: /Edit in wiki/ }).getAttribute('href')).toMatch(/\/n\/w1$/);
  expect(screen.getByRole('button', { name: 'Publish v5' })).toBeTruthy();
  expect(screen.getByText('Company shirt, tucked in.')).toBeTruthy();
  const tabs = screen.getByRole('tablist');
  expect(within(tabs).getByRole('tab', { name: 'Content and rules' }).getAttribute('aria-selected')).toBe('true');
  await waitFor(() => expect(within(tabs).getByRole('tab', { name: /Sign-offs/ }).textContent).toContain('312'));
  expect(within(tabs).getByRole('tab', { name: /Versions/ }).textContent).toContain('2');
  expect(within(tabs).getByRole('tab', { name: /Translations/ }).textContent).toContain('3');
});

it('an unpublished document says Not published and offers Publish v1', async () => {
  api.getLearningDocument.mockResolvedValue({
    ...DOC, current_version_id: null, current_version_no: null, current_html: null, versions: [],
  });
  renderPage();
  await ready();
  expect(screen.getByText('Not published')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Publish v1' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Preview as worker/ })).toBeNull();
});

it('?tab= opens that tab', async () => {
  renderPage('/learning/library/d1?tab=versions');
  await ready();
  expect(screen.getByRole('tab', { name: /Versions/ }).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByText('Added ESD wrist strap rule')).toBeTruthy();
});

it('the validity select offers exactly the brief’s choices and PATCHes validity_days', async () => {
  renderPage();
  await ready();
  const select = screen.getByLabelText('Valid for') as HTMLSelectElement;
  expect(Array.from(select.options).map((o) => [o.value, o.text])).toEqual([
    ['never', 'Never'], ['30', '30 days'], ['90', '90 days'],
    ['182', '6 months'], ['365', '1 year'], ['custom', 'Custom days'],
  ]);
  expect(select.value).toBe('365');

  fireEvent.change(select, { target: { value: '182' } });
  await waitFor(() => expect(api.patchLearningDocument).toHaveBeenLastCalledWith('d1', { validity_days: 182 }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith('Saved'));

  fireEvent.change(select, { target: { value: 'never' } });
  await waitFor(() => expect(api.patchLearningDocument).toHaveBeenLastCalledWith('d1', { validity_days: null }));
});

it('Custom days takes a number and saves it when you leave the box', async () => {
  renderPage();
  await ready();
  fireEvent.change(screen.getByLabelText('Valid for'), { target: { value: 'custom' } });
  // choosing Custom alone saves nothing
  expect(api.patchLearningDocument).not.toHaveBeenCalled();
  const days = screen.getByLabelText('Custom validity in days') as HTMLInputElement;
  fireEvent.change(days, { target: { value: '45' } });
  fireEvent.blur(days);
  await waitFor(() => expect(api.patchLearningDocument).toHaveBeenCalledWith('d1', { validity_days: 45 }));

  // junk is refused where it is typed
  api.patchLearningDocument.mockClear();
  fireEvent.change(days, { target: { value: '0' } });
  fireEvent.blur(days);
  expect(api.patchLearningDocument).not.toHaveBeenCalled();
  expect(screen.getByText(/whole number of days/i)).toBeTruthy();
});

it('the re-sign rule is two option cards; picking the other PATCHes resign_rule', async () => {
  renderPage();
  await ready();
  const group = screen.getByRole('radiogroup', { name: /joins a new initiative/i });
  const every = within(group).getByRole('radio', { name: /Sign again every initiative/ });
  const expired = within(group).getByRole('radio', { name: /Only if expired or there.s a new version/ });
  expect(within(group).getByText('Best for client NDAs and site rules')).toBeTruthy();
  expect(within(group).getByText('Best for company-wide policies')).toBeTruthy();
  expect(expired.getAttribute('aria-checked')).toBe('true');
  expect(every.getAttribute('aria-checked')).toBe('false');

  fireEvent.click(every);
  await waitFor(() => expect(api.patchLearningDocument).toHaveBeenCalledWith('d1', { resign_rule: 'every_initiative' }));
  await waitFor(() => expect(every.getAttribute('aria-checked')).toBe('true'));
  // choosing what is already chosen saves nothing
  api.patchLearningDocument.mockClear();
  fireEvent.click(every);
  expect(api.patchLearningDocument).not.toHaveBeenCalled();
});

it('sign style, scroll-to-end, reading time and seconds each PATCH their own field', async () => {
  renderPage();
  await ready();
  expect(screen.getByRole('button', { name: 'Typed name' }).getAttribute('aria-pressed')).toBe('true');

  fireEvent.click(screen.getByRole('button', { name: 'Drawn signature' }));
  await waitFor(() => expect(api.patchLearningDocument).toHaveBeenLastCalledWith('d1', { sign_style: 'drawn_signature' }));

  fireEvent.click(screen.getByRole('checkbox', { name: 'Must scroll to the end' }));
  await waitFor(() => expect(api.patchLearningDocument).toHaveBeenLastCalledWith('d1', { require_scroll: false }));

  const seconds = screen.getByLabelText('Minimum reading time in seconds') as HTMLInputElement;
  expect(seconds.value).toBe('60');
  fireEvent.change(seconds, { target: { value: '90' } });
  fireEvent.blur(seconds);
  await waitFor(() => expect(api.patchLearningDocument).toHaveBeenLastCalledWith('d1', { min_read_seconds: 90 }));

  fireEvent.click(screen.getByRole('checkbox', { name: 'Minimum reading time' }));
  await waitFor(() => expect(api.patchLearningDocument).toHaveBeenLastCalledWith('d1', { min_read_seconds: null }));
  await waitFor(() => expect(screen.queryByLabelText('Minimum reading time in seconds')).toBeNull());
});

it('the quiz toggle needs a pass mark first, then PATCHes quiz_enabled', async () => {
  const user = userEvent.setup();
  renderPage();
  await ready();
  await user.click(screen.getByRole('checkbox', { name: 'Quiz after reading' }));
  expect(api.patchLearningDocument).not.toHaveBeenCalled();
  expect(screen.getByText(/set a pass mark on the quiz tab first/i)).toBeTruthy();

  cleanup();
  api.getLearningDocument.mockResolvedValue({ ...DOC, quiz_pass_percent: 80 });
  renderPage();
  await ready();
  await user.click(screen.getByRole('checkbox', { name: 'Quiz after reading' }));
  await waitFor(() => expect(api.patchLearningDocument).toHaveBeenCalledWith('d1', { quiz_enabled: true }));
});

it('a failed save toasts the reason and puts the old value back', async () => {
  api.patchLearningDocument.mockRejectedValueOnce(new ApiError(
    422, 'bad', { code: 'bad', message: 'Validity must be at least one day.' }));
  renderPage();
  await ready();
  const select = screen.getByLabelText('Valid for') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: '30' } });
  await waitFor(() => expect(toast).toHaveBeenCalledWith('Couldn’t save: Validity must be at least one day.'));
  await waitFor(() => expect(select.value).toBe('365'));
});

it('view-only managers see the rules as read-only text with no controls or Publish', async () => {
  auth.perms = { view: true };
  renderPage();
  await ready();
  expect(screen.queryByLabelText('Valid for')).toBeNull();
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('button', { name: /Publish/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Archive/ })).toBeNull();
  expect(screen.getByText('1 year')).toBeTruthy();
  expect(screen.getByText('Typed name')).toBeTruthy();
  expect(screen.getByText(/Only if expired or there.s a new version/)).toBeTruthy();
  expect(screen.getByText('60 sec')).toBeTruthy();
});

it('Publish opens the modal and sends the change note', async () => {
  const user = userEvent.setup();
  renderPage();
  await ready();
  await user.click(screen.getByRole('button', { name: 'Publish v5' }));
  const dialog = await screen.findByRole('dialog', { name: /publish version 5/i });
  await user.type(within(dialog).getByLabelText(/what changed/i), 'Added ESD wrist strap rule');
  await user.click(within(dialog).getByRole('button', { name: 'Publish v5' }));
  await waitFor(() => expect(api.publishLearningDocument).toHaveBeenCalledWith('d1', 'Added ESD wrist strap rule'));
  await waitFor(() => expect(toast).toHaveBeenCalledWith('Published v5'));
  // the page reloads the document it just changed
  await waitFor(() => expect(api.getLearningDocument).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('Publish with no note sends none, and a failure stays in the modal', async () => {
  api.publishLearningDocument.mockRejectedValueOnce(new ApiError(
    409, 'no_changes', { code: 'no_changes', message: 'x' }));
  const user = userEvent.setup();
  renderPage();
  await ready();
  await user.click(screen.getByRole('button', { name: 'Publish v5' }));
  const dialog = await screen.findByRole('dialog', { name: /publish version 5/i });
  await user.click(within(dialog).getByRole('button', { name: 'Publish v5' }));
  await waitFor(() => expect(api.publishLearningDocument).toHaveBeenCalledWith('d1', undefined));
  expect(await within(dialog).findByText(/hasn.t changed since the last version/i)).toBeTruthy();
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('Preview as worker renders the HTML in a phone-width modal with a language select', async () => {
  const user = userEvent.setup();
  renderPage();
  await ready();
  await user.click(screen.getByRole('button', { name: /Preview as worker/ }));
  const dialog = await screen.findByRole('dialog', { name: /preview as worker/i });
  expect(within(dialog).getByText('Company shirt, tucked in.')).toBeTruthy();
  const select = within(dialog).getByLabelText('Language') as HTMLSelectElement;
  expect(Array.from(select.options).map((o) => o.value)).toEqual(['en', 'ja', 'ko', 'he']);

  fireEvent.change(select, { target: { value: 'ja' } });
  expect(await within(dialog).findByText('作業服')).toBeTruthy();
  expect(api.getTranslation).toHaveBeenCalledWith('d1', 'ja');
});

it('Versions lists the notes and counts; a row shows that version’s HTML', async () => {
  const user = userEvent.setup();
  renderPage('/learning/library/d1?tab=versions');
  await ready();
  const note = await screen.findByText('Safety shoe wording');
  const row = note.closest('.dir-row') as HTMLElement;
  expect(within(row).getByText('Laura Chen')).toBeTruthy();
  expect(within(row).getByText('12')).toBeTruthy();
  await user.click(row.querySelector('.row-main') as HTMLElement);
  await waitFor(() => expect(api.getLearningVersion).toHaveBeenCalledWith('d1', 'v3'));
  expect(await screen.findByText('Old shoe wording')).toBeTruthy();
});

it('Sign-offs pages through the list with Load more', async () => {
  const item = (n: number) => ({
    id: `s${n}`, person: { id: `p${n}`, name: `Worker ${n}` }, version_no: 4, language: 'en',
    signed_at: '2026-10-20T15:00:00Z', read_seconds: 75, quiz_score: null,
    initiative_id: null, initiative: null,
  });
  api.listDocumentSignoffs.mockImplementation(async (_id: string, opts: { offset?: number; limit?: number } = {}) => ({
    total: 3, version_counts: { v4: 3 },
    items: (opts.offset ?? 0) === 0 ? [item(1), item(2)] : [item(3)],
  }));
  const user = userEvent.setup();
  renderPage('/learning/library/d1?tab=signoffs');
  await ready();
  expect(await screen.findByText('Worker 1')).toBeTruthy();
  expect(screen.getByText('2 of 3 shown')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Worker 3')).toBeTruthy();
  expect(api.listDocumentSignoffs).toHaveBeenCalledWith('d1', expect.objectContaining({ offset: 2 }));
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});

it('Archive asks first, archives and returns to the library', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  renderPage();
  await ready();
  await user.click(screen.getByRole('button', { name: 'Archive' }));
  await waitFor(() => expect(api.archiveLearningDocument).toHaveBeenCalledWith('d1'));
  expect(await screen.findByText('Library page')).toBeTruthy();
});

it('a missing document says so', async () => {
  api.getLearningDocument.mockRejectedValue(new ApiError(404, 'not_found'));
  renderPage();
  expect(await screen.findByText(/document not found/i)).toBeTruthy();
});

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

it('rapid edits are sent one PATCH at a time and the UI ends on the last choice', async () => {
  const first = deferred<Doc>();
  const second = deferred<Doc>();
  api.patchLearningDocument
    .mockReset()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  renderPage();
  await ready();
  const select = screen.getByLabelText('Valid for') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: '182' } });
  fireEvent.change(select, { target: { value: '90' } });
  expect(select.value).toBe('90');
  // the second goes out only after the first has come back
  await waitFor(() => expect(api.patchLearningDocument).toHaveBeenCalledTimes(1));
  await new Promise((r) => setTimeout(r, 20));
  expect(api.patchLearningDocument).toHaveBeenCalledTimes(1);
  first.resolve({ ...DOC, validity_days: 182 });
  await waitFor(() => expect(api.patchLearningDocument).toHaveBeenCalledTimes(2));
  expect(api.patchLearningDocument.mock.calls.map((c) => c[1])).toEqual([
    { validity_days: 182 }, { validity_days: 90 }]);
  // between the two responses the control still shows the newer choice
  expect(select.value).toBe('90');
  second.resolve({ ...DOC, validity_days: 90 });
  await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
  expect(select.value).toBe('90');
});

it('a failed earlier save does not snap the control back over a newer pending choice', async () => {
  const first = deferred<Doc>();
  const second = deferred<Doc>();
  api.patchLearningDocument
    .mockReset()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  renderPage();
  await ready();
  const select = screen.getByLabelText('Valid for') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: '30' } });
  fireEvent.change(select, { target: { value: '90' } });
  first.reject(new ApiError(500, 'boom'));
  await waitFor(() => expect(api.patchLearningDocument).toHaveBeenCalledTimes(2));
  expect(select.value).toBe('90');
  second.resolve({ ...DOC, validity_days: 90 });
  await waitFor(() => expect(select.value).toBe('90'));
});

it('toggling the quiz on then off quickly ends off', async () => {
  const first = deferred<Doc>();
  const second = deferred<Doc>();
  api.getLearningDocument.mockResolvedValue({ ...DOC, quiz_pass_percent: 80 });
  api.patchLearningDocument
    .mockReset()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  renderPage();
  await ready();
  const box = screen.getByRole('checkbox', { name: 'Quiz after reading' }) as HTMLInputElement;
  fireEvent.click(box);
  fireEvent.click(box);
  expect(box.checked).toBe(false);
  first.resolve({ ...DOC, quiz_pass_percent: 80, quiz_enabled: true });
  await waitFor(() => expect(api.patchLearningDocument).toHaveBeenCalledTimes(2));
  expect(box.checked).toBe(false);
  second.resolve({ ...DOC, quiz_pass_percent: 80, quiz_enabled: false });
  await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
  expect(box.checked).toBe(false);
  expect(api.patchLearningDocument.mock.calls.map((c) => c[1])).toEqual([
    { quiz_enabled: true }, { quiz_enabled: false }]);
});

it('leaving Custom days untouched shows no error', async () => {
  renderPage();
  await ready();
  fireEvent.change(screen.getByLabelText('Valid for'), { target: { value: 'never' } });
  await waitFor(() => expect(api.patchLearningDocument).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Valid for'), { target: { value: 'custom' } });
  fireEvent.blur(screen.getByLabelText('Custom validity in days'));
  expect(screen.queryByText(/whole number of days/i)).toBeNull();
});

it('Sign-offs drops a row repeated across pages', async () => {
  const item = (n: number) => ({
    id: `s${n}`, person: { id: `p${n}`, name: `Worker ${n}` }, version_no: 4, language: 'en',
    signed_at: '2026-10-20T15:00:00Z', read_seconds: 75, quiz_score: null,
    initiative_id: null, initiative: null,
  });
  api.listDocumentSignoffs.mockImplementation(async (_id: string, opts: { offset?: number } = {}) => ({
    total: 3, version_counts: { v4: 3 },
    items: (opts.offset ?? 0) === 0 ? [item(1), item(2)] : [item(2), item(3)],
  }));
  const user = userEvent.setup();
  renderPage('/learning/library/d1?tab=signoffs');
  await ready();
  await screen.findByText('Worker 1');
  await user.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('Worker 3');
  expect(screen.getAllByText('Worker 2').length).toBe(1);
  expect(screen.getByText('3 of 3 shown')).toBeTruthy();
});
