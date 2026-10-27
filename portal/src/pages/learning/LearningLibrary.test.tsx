// @vitest-environment jsdom
/**
 * /learning/library — the document list (title, version, published, packets,
 * sign-offs, translation chips), its search, and the New document flow
 * (a wiki page from the learning space plus a title, then onto the
 * document's own page). New document needs learning:add.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { LearningDocumentListItem, WikiPageOption } from '../../lib/learning';

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
  }),
}));

const api = vi.hoisted(() => ({
  listLearningDocuments: vi.fn(),
  listLearningWikiPages: vi.fn(),
  createLearningDocument: vi.fn(),
}));
vi.mock('../../lib/learning', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/learning')>()),
  ...api,
}));

const { default: LearningLibrary } = await import('./LearningLibrary');

const DOCS: LearningDocumentListItem[] = [
  {
    id: 'd1', title: 'Dress code', current_version_no: 4, published_at: '2026-10-12T15:00:00Z',
    packets: ['Standard onboarding', 'Acme site rules'], signoff_count: 312,
    languages: { ja: 'published', ko: 'in_review', he: 'out_of_date' }, archived_at: null,
  },
  {
    id: 'd2', title: 'Acme NDA', current_version_no: null, published_at: null,
    packets: [], signoff_count: 0, languages: {}, archived_at: null,
  },
];

const PAGES: WikiPageOption[] = [
  { id: 'w1', title: 'Forklift safety', path: ['Onboarding'], published_version_no: 2 },
  { id: 'w2', title: 'Draft only', path: [], published_version_no: null },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/learning/library']}>
      <Routes>
        <Route path="/learning/library" element={<LearningLibrary />} />
        <Route path="/learning/library/:documentId" element={<div>Document page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.perms = { view: true, add: true, change: true, delete: true };
  api.listLearningDocuments.mockReset().mockResolvedValue(DOCS);
  api.listLearningWikiPages.mockReset().mockResolvedValue(PAGES);
  api.createLearningDocument.mockReset().mockResolvedValue({ id: 'new-1' });
  toast.mockReset();
});
afterEach(cleanup);

it('lists documents with version, published date, packets, sign-offs and translation chips', async () => {
  renderPage();
  const link = await screen.findByRole('link', { name: 'Dress code' });
  expect(link.getAttribute('href')).toBe('/learning/library/d1');
  const row = link.closest('.dir-row') as HTMLElement;
  expect(within(row).getByText('v4')).toBeTruthy();
  expect(within(row).getByText('Standard onboarding, Acme site rules')).toBeTruthy();
  expect(within(row).getByText('312')).toBeTruthy();
  // one chip per language, colored by its status
  const ja = within(row).getByText('JA');
  expect(ja.className).toContain('c-green');
  expect(ja.getAttribute('title')).toBe('Japanese: Published');
  expect(within(row).getByText('KO').className).toContain('c-amber');
  expect(within(row).getByText('HE').className).toContain('c-red');
  expect(within(row).getByText('HE').getAttribute('title')).toBe('Hebrew: Out of date');
  // an unpublished document says so
  const unpublished = screen.getByRole('link', { name: 'Acme NDA' }).closest('.dir-row') as HTMLElement;
  expect(within(unpublished).getByText('Not published')).toBeTruthy();
  expect(api.listLearningDocuments).toHaveBeenCalledWith();
});

it('search narrows the list', async () => {
  renderPage();
  await screen.findByRole('link', { name: 'Dress code' });
  fireEvent.change(screen.getByPlaceholderText(/search documents/i), { target: { value: 'acme nda' } });
  expect(screen.queryByRole('link', { name: 'Dress code' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Acme NDA' })).toBeTruthy();
  expect(screen.getByText('1 of 2 shown')).toBeTruthy();
});

it('shows an empty state and a load failure with retry', async () => {
  api.listLearningDocuments.mockResolvedValueOnce([]);
  const first = renderPage();
  expect(await screen.findByText(/no documents yet/i)).toBeTruthy();
  first.unmount();

  api.listLearningDocuments.mockRejectedValueOnce(new ApiError(500, 'boom'));
  renderPage();
  expect(await screen.findByText(/couldn.t load the library/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('link', { name: 'Dress code' })).toBeTruthy();
});

it('New document creates from a learning wiki page and opens the document', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByRole('link', { name: 'Dress code' });
  await user.click(screen.getByRole('button', { name: 'New document' }));

  const dialog = await screen.findByRole('dialog', { name: /new learning document/i });
  expect(within(dialog).getByRole('button', { name: 'Create document' }).hasAttribute('disabled')).toBe(true);
  fireEvent.focus(within(dialog).getByLabelText('Wiki page'));
  fireEvent.mouseDown(screen.getByText('Forklift safety'));
  // the title starts as the page's title and can be changed
  const title = within(dialog).getByLabelText('Title') as HTMLInputElement;
  expect(title.value).toBe('Forklift safety');
  fireEvent.change(title, { target: { value: 'Forklift safety basics' } });
  await user.click(within(dialog).getByRole('button', { name: 'Create document' }));

  await waitFor(() => expect(api.createLearningDocument).toHaveBeenCalledWith(
    { title: 'Forklift safety basics', wiki_node_id: 'w1' }));
  expect(await screen.findByText('Document page')).toBeTruthy();
});

it('a create failure stays in the dialog with the server wording', async () => {
  api.createLearningDocument.mockRejectedValueOnce(new ApiError(
    422, 'odd_page', { code: 'odd_page', message: 'Private pages can’t be linked.' }));
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'New document' }));
  const dialog = await screen.findByRole('dialog', { name: /new learning document/i });
  fireEvent.focus(within(dialog).getByLabelText('Wiki page'));
  fireEvent.mouseDown(screen.getByText('Forklift safety'));
  await user.click(within(dialog).getByRole('button', { name: 'Create document' }));
  expect(await within(dialog).findByText(/private pages can.t be linked/i)).toBeTruthy();
  expect(screen.queryByText('Document page')).toBeNull();
});

it('without learning:add there is no New document button', async () => {
  auth.perms = { view: true };
  renderPage();
  await screen.findByRole('link', { name: 'Dress code' });
  expect(screen.queryByRole('button', { name: 'New document' })).toBeNull();
});
