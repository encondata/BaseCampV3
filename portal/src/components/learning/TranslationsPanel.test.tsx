// @vitest-environment jsdom
/**
 * The Translations tab: a row per configured language with its status chip
 * (out of date included) and the actions its status allows — Translate draft,
 * Edit (title + HTML + live preview), Submit for review, Approve. Approve is
 * hidden from the translation's last editor unless they are a developer, and
 * the API's self_review refusal reads in plain language anyway.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { Translation, TranslationStatusRow } from '../../lib/learning';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const auth = vi.hoisted(() => ({
  perms: { view: true, add: true, change: true, delete: true } as Record<string, boolean>,
  developer: false,
}));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string, action = 'view') => resource === 'learning' && auth.perms[action] === true,
    scope: { global: true },
    preferences: {},
    updatePreferences: vi.fn(),
    hasRole: (...names: string[]) => auth.developer && names.includes('developer'),
    person: { id: 'me' },
  }),
}));

const api = vi.hoisted(() => ({
  getTranslation: vi.fn(),
  saveTranslation: vi.fn(),
  draftTranslation: vi.fn(),
  submitTranslation: vi.fn(),
  approveTranslation: vi.fn(),
}));
vi.mock('../../lib/learning', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/learning')>()),
  ...api,
}));

const { default: TranslationsPanel } = await import('./TranslationsPanel');

const row = (language: string, status: TranslationStatusRow['status'], version_no: number | null = 4): TranslationStatusRow => ({
  language, status, version_no, updated_at: version_no ? '2026-10-13T00:00:00Z' : null, reviewed_by: null,
});

const ROWS = [row('ja', 'published'), row('ko', 'in_review'), row('he', 'out_of_date', 3), row('es', 'missing', null)];

const tr = (language: string, over: Partial<Translation> = {}): Translation => ({
  language, status: 'in_review', version_no: 4, current_version_no: 4, title: 'Title', content_html: '<p>Body</p>',
  source: 'claude', updated_at: '2026-10-13T00:00:00Z', updated_by: { id: 'someone', name: 'Laura Chen' },
  reviewed_by: null, reviewed_at: null, ...over,
});

const onReload = vi.fn();

function renderPanel(rows = ROWS, published = true) {
  return render(<TranslationsPanel documentId="d1" currentVersionNo={published ? 4 : null}
                                   rows={rows} onReload={onReload} />);
}
const rowOf = (name: RegExp | string) =>
  screen.getByText(name).closest('.dir-row') as HTMLElement;

beforeEach(() => {
  auth.perms = { view: true, add: true, change: true, delete: true };
  auth.developer = false;
  api.getTranslation.mockReset().mockImplementation(async (_d: string, lang: string) => tr(lang));
  api.saveTranslation.mockReset().mockResolvedValue(tr('ko'));
  api.draftTranslation.mockReset().mockResolvedValue(tr('es', { status: 'draft' }));
  api.submitTranslation.mockReset().mockResolvedValue(tr('ko'));
  api.approveTranslation.mockReset().mockResolvedValue(tr('ko', { status: 'published' }));
  onReload.mockReset();
  toast.mockReset();
});
afterEach(cleanup);

it('shows a status chip per language, out of date included', async () => {
  renderPanel();
  expect(within(rowOf('Japanese')).getByText('Published').className).toContain('c-green');
  expect(within(rowOf('Korean')).getByText('In review').className).toContain('c-amber');
  const he = within(rowOf('Hebrew')).getByText('Out of date');
  expect(he.className).toContain('c-red');
  expect(within(rowOf('Hebrew')).getByText('v3')).toBeTruthy();
  expect(within(rowOf('es')).getByText('Not translated')).toBeTruthy();
});

it('Approve shows for someone else’s in-review translation and approves it', async () => {
  const user = userEvent.setup();
  renderPanel();
  const approve = await within(rowOf('Korean')).findByRole('button', { name: 'Approve' });
  await user.click(approve);
  await waitFor(() => expect(api.approveTranslation).toHaveBeenCalledWith('d1', 'ko'));
  await waitFor(() => expect(onReload).toHaveBeenCalled());
  expect(toast).toHaveBeenCalledWith('Approved the Korean translation');
  // only in-review rows can be approved
  expect(within(rowOf('Japanese')).queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(within(rowOf('Hebrew')).queryByRole('button', { name: 'Approve' })).toBeNull();
});

it('Approve is hidden for the last editor', async () => {
  api.getTranslation.mockImplementation(async (_d: string, lang: string) =>
    tr(lang, { updated_by: { id: 'me', name: 'Me' } }));
  renderPanel();
  await waitFor(() => expect(api.getTranslation).toHaveBeenCalledWith('d1', 'ko'));
  expect(await within(rowOf('Korean')).findByText(/someone else has to approve/i)).toBeTruthy();
  expect(within(rowOf('Korean')).queryByRole('button', { name: 'Approve' })).toBeNull();
});

it('a developer can approve their own edit', async () => {
  auth.developer = true;
  api.getTranslation.mockImplementation(async (_d: string, lang: string) =>
    tr(lang, { updated_by: { id: 'me', name: 'Me' } }));
  renderPanel();
  expect(await within(rowOf('Korean')).findByRole('button', { name: 'Approve' })).toBeTruthy();
});

it('self_review from the API reads in plain language', async () => {
  api.approveTranslation.mockRejectedValueOnce(new ApiError(409, 'self_review', { code: 'self_review', message: 'x' }));
  const user = userEvent.setup();
  renderPanel();
  await user.click(await within(rowOf('Korean')).findByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('Someone other than the last editor has to approve this translation.')).toBeTruthy();
});

it('Translate draft asks Claude for that language and reloads', async () => {
  const user = userEvent.setup();
  renderPanel();
  await user.click(within(rowOf('es')).getByRole('button', { name: 'Translate draft' }));
  await waitFor(() => expect(api.draftTranslation).toHaveBeenCalledWith('d1', 'es'));
  await waitFor(() => expect(onReload).toHaveBeenCalled());
  expect(toast).toHaveBeenCalledWith('Drafted the Spanish translation');
});

it('Translate draft maps an unavailable Claude to a plain message', async () => {
  api.draftTranslation.mockRejectedValueOnce(new ApiError(503, 'translation_unavailable', { code: 'translation_unavailable', message: 'x' }));
  const user = userEvent.setup();
  renderPanel();
  await user.click(within(rowOf('es')).getByRole('button', { name: 'Translate draft' }));
  expect(await screen.findByText('Translating with Claude isn’t available right now.')).toBeTruthy();
});

it('Submit for review is offered on a draft', async () => {
  const user = userEvent.setup();
  renderPanel([row('ko', 'draft'), row('ja', 'published')]);
  expect(within(rowOf('Japanese')).queryByRole('button', { name: 'Submit for review' })).toBeNull();
  await user.click(within(rowOf('Korean')).getByRole('button', { name: 'Submit for review' }));
  await waitFor(() => expect(api.submitTranslation).toHaveBeenCalledWith('d1', 'ko'));
  await waitFor(() => expect(onReload).toHaveBeenCalled());
});

it('Edit opens a title, an HTML box and a live preview, and saves both', async () => {
  const user = userEvent.setup();
  renderPanel();
  await user.click(within(rowOf('Korean')).getByRole('button', { name: 'Edit' }));
  const dialog = await screen.findByRole('dialog', { name: /edit korean translation/i });
  const title = await within(dialog).findByLabelText('Title') as HTMLInputElement;
  const html = within(dialog).getByLabelText('HTML') as HTMLTextAreaElement;
  await waitFor(() => expect(title.value).toBe('Title'));
  expect(html.value).toBe('<p>Body</p>');

  fireEvent.change(title, { target: { value: '복장 규정' } });
  fireEvent.change(html, { target: { value: '<p>작업복</p>' } });
  // typed HTML is previewed in a sandboxed frame, never injected into the portal
  const frame = within(dialog).getByTitle('Translation preview') as HTMLIFrameElement;
  expect(frame.getAttribute('sandbox')).toBe('');
  expect(frame.getAttribute('srcdoc')).toContain('<p>작업복</p>');
  expect(frame.getAttribute('srcdoc')).toContain('dir="ltr"');
  expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'; img-src https: data:; style-src 'unsafe-inline'");

  await user.click(within(dialog).getByRole('button', { name: 'Save translation' }));
  await waitFor(() => expect(api.saveTranslation).toHaveBeenCalledWith(
    'd1', 'ko', { title: '복장 규정', content_html: '<p>작업복</p>' }));
  await waitFor(() => expect(onReload).toHaveBeenCalled());
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('Hebrew previews right to left; a missing language starts blank', async () => {
  const user = userEvent.setup();
  api.getTranslation.mockImplementation(async (_d: string, lang: string) => {
    if (lang === 'es') throw new ApiError(404, 'not_found');
    return tr(lang);
  });
  renderPanel();
  await user.click(within(rowOf('Hebrew')).getByRole('button', { name: 'Edit' }));
  let dialog = await screen.findByRole('dialog', { name: /edit hebrew translation/i });
  await waitFor(() => expect((within(dialog).getByLabelText('Title') as HTMLInputElement).value).toBe('Title'));
  expect(within(dialog).getByTitle('Translation preview').getAttribute('srcdoc')).toContain('dir="rtl"');
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  await user.click(within(rowOf('es')).getByRole('button', { name: 'Write one' }));
  dialog = await screen.findByRole('dialog', { name: /edit Spanish translation/i });
  expect((within(dialog).getByLabelText('Title') as HTMLInputElement).value).toBe('');
  expect((within(dialog).getByLabelText('HTML') as HTMLTextAreaElement).value).toBe('');
});

it('a save with no title or no content is refused before it is sent', async () => {
  const user = userEvent.setup();
  api.getTranslation.mockRejectedValue(new ApiError(404, 'not_found'));
  renderPanel();
  await user.click(within(rowOf('es')).getByRole('button', { name: 'Write one' }));
  const dialog = await screen.findByRole('dialog', { name: /edit Spanish translation/i });
  await user.click(within(dialog).getByRole('button', { name: 'Save translation' }));
  expect(within(dialog).getByText('The translation needs a title.')).toBeTruthy();
  expect(api.saveTranslation).not.toHaveBeenCalled();
});

it('view-only managers see the statuses and no actions', async () => {
  auth.perms = { view: true };
  renderPanel();
  expect(within(rowOf('Korean')).getByText('In review')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Translate draft' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull();
});

it('an unpublished document says to publish first and offers no actions', async () => {
  renderPanel(ROWS.map((r) => ({ ...r, status: 'missing' as const, version_no: null })), false);
  expect(screen.getByText(/publish the document before translating it/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Translate draft' })).toBeNull();
});

it('with no languages configured it says so', () => {
  renderPanel([]);
  expect(screen.getByText(/no languages are set up/i)).toBeTruthy();
});

it('a new edit to an in-review translation is looked at again (keyed by language and edit time)', async () => {
  const { rerender } = renderPanel();
  await within(rowOf('Korean')).findByRole('button', { name: 'Approve' });
  expect(api.getTranslation).toHaveBeenCalledTimes(1);
  api.getTranslation.mockImplementation(async (_d: string, lang: string) =>
    tr(lang, { updated_by: { id: 'me', name: 'Me' } }));
  rerender(<TranslationsPanel documentId="d1" currentVersionNo={4} onReload={onReload}
                              rows={ROWS.map((r) => (r.language === 'ko' ? { ...r, updated_at: '2026-10-14T00:00:00Z' } : r))} />);
  expect(await within(rowOf('Korean')).findByText(/someone else has to approve/i)).toBeTruthy();
  expect(within(rowOf('Korean')).queryByRole('button', { name: 'Approve' })).toBeNull();
});

it('the preview frame escapes the language attribute', async () => {
  const { previewDocument } = await import('./TranslationEditModal');
  expect(previewDocument('<p>x</p>', 'en"><script>')).toContain('lang="en&quot;&gt;&lt;script&gt;"');
});
