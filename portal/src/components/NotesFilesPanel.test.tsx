// @vitest-environment jsdom
/**
 * NotesFilesPanel: collapsed-by-default with a live badge, and the
 * image-attachment thumbnail/lightbox split (V2 parity) — image
 * attachments move out of the plain 📎 row list into a thumbnail grid,
 * and clicking a thumbnail opens a full-size lightbox that closes on
 * Escape or a scrim click. Partners upload documents/photos like every
 * other host now — the survey template moved to the report definition's
 * Files section (see EditDefinitionModal) — but `kindLabel` still renders
 * a legacy `survey_template` row's chip so old data doesn't crash.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type AttachmentOut, type NoteOut } from '../lib/api';

const api = vi.hoisted(() => ({
  listNotes: vi.fn(),
  listAttachments: vi.fn(),
  uploadAttachmentRequest: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  updateAttachment: vi.fn(),
}));

const auth = vi.hoisted(() => ({
  maxRank: 40,
  scope: { global: true, client_ids: [], partner_ids: [] } as
    { global: boolean; client_ids: string[]; partner_ids: string[] } | null,
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ maxRank: auth.maxRank, scope: auth.scope }),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

function note(id: string, over: Partial<NoteOut> = {}): NoteOut {
  return {
    id, entity_type: 'site', entity_id: 'site-1', body: `Note ${id}`,
    created_by: null, author_name: 'Someone',
    created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
    visibility: 'everyone', ...over,
  };
}

function attachment(over: Partial<AttachmentOut>): AttachmentOut {
  return {
    id: 'file-1', entity_type: 'site', entity_id: 'site-1', kind: 'document',
    storage_key: 'k', filename: 'report.pdf', content_type: 'application/pdf',
    size_bytes: 2048, created_at: '2026-08-01T00:00:00Z', url: 'https://x/report.pdf',
    visibility: 'everyone', ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.maxRank = 40;
  auth.scope = { global: true, client_ids: [], partner_ids: [] };
});

afterEach(cleanup);

const { default: NotesFilesPanel } = await import('./NotesFilesPanel');

it('renders collapsed by default with the body hidden', async () => {
  api.listNotes.mockResolvedValue([note('n1')]);
  api.listAttachments.mockResolvedValue([]);

  render(<NotesFilesPanel entityType="site" entityId="site-1" canWrite={false} />);

  await waitFor(() => expect(screen.getByText('1 notes · 0 files')).toBeDefined());

  // the note body is mounted (badge could populate) but its section is hidden
  const body = document.querySelector('.collapse-body');
  expect(body).not.toBeNull();
  expect(body).toHaveProperty('hidden', true);
});

it('expanding shows a badge count and splits image vs non-image attachments', async () => {
  const user = userEvent.setup();
  api.listNotes.mockResolvedValue([]);
  api.listAttachments.mockResolvedValue([
    attachment({ id: 'img-1', filename: 'site.png', content_type: 'image/png', url: 'https://x/site.png' }),
    attachment({ id: 'doc-1', filename: 'manual.pdf', content_type: 'application/pdf', url: 'https://x/manual.pdf' }),
  ]);

  render(<NotesFilesPanel entityType="site" entityId="site-1" canWrite={false} />);

  await waitFor(() => expect(screen.getByText('0 notes · 2 files')).toBeDefined());

  await user.click(screen.getByRole('button', { expanded: false }));

  // image attachment renders as a thumbnail, not a 📎 row
  const thumbButton = await screen.findByRole('button', { name: 'Open site.png' });
  expect(thumbButton.querySelector('img')).toHaveProperty('src', 'https://x/site.png');
  expect(screen.queryByText(/📎 site\.png/)).toBeNull();

  // non-image attachment stays a plain 📎 row
  expect(screen.getByText(/📎 manual\.pdf/)).toBeDefined();
});

it('opens and closes the lightbox for a thumbnail', async () => {
  const user = userEvent.setup();
  api.listNotes.mockResolvedValue([]);
  api.listAttachments.mockResolvedValue([
    attachment({ id: 'img-1', filename: 'site.png', content_type: 'image/png', url: 'https://x/site.png' }),
  ]);

  render(<NotesFilesPanel entityType="site" entityId="site-1" canWrite={false} />);

  await user.click(await screen.findByRole('button', { expanded: false }));
  await user.click(await screen.findByRole('button', { name: 'Open site.png' }));

  expect(screen.getByText('site.png', { selector: '.nf-lightbox-caption' })).toBeDefined();

  await user.keyboard('{Escape}');

  await waitFor(() => expect(
    screen.queryByText('site.png', { selector: '.nf-lightbox-caption' }),
  ).toBeNull());
});

it('a partner upload sends kind document (or photo for images), with no upload-type tablist', async () => {
  const user = userEvent.setup();
  api.listNotes.mockResolvedValue([]);
  api.listAttachments.mockResolvedValue([]);
  api.uploadAttachmentRequest.mockResolvedValue(attachment({}));

  render(<NotesFilesPanel entityType="partner" entityId="p1" canWrite />);
  await user.click(await screen.findByRole('button', { expanded: false }));
  expect(screen.queryByRole('tablist')).toBeNull();

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const pdf = new File(['x'], 'contract.pdf', { type: 'application/pdf' });
  await user.upload(input, pdf);
  await waitFor(() => expect(api.uploadAttachmentRequest).toHaveBeenCalledWith({
    entityType: 'partner', entityId: 'p1', kind: 'document', file: pdf, visibility: 'everyone',
  }));

  const png = new File(['x'], 'site.png', { type: 'image/png' });
  await user.upload(input, png);
  await waitFor(() => expect(api.uploadAttachmentRequest).toHaveBeenCalledWith({
    entityType: 'partner', entityId: 'p1', kind: 'photo', file: png, visibility: 'everyone',
  }));
});

// ── visibility (Everyone / Internal / Admin) ─────────────────────────

const HINT = 'Everyone includes client and partner users who can see this record.';

async function openPanel(canWrite = true) {
  const user = userEvent.setup();
  render(<NotesFilesPanel entityType="site" entityId="site-1" canWrite={canWrite} />);
  await user.click(await screen.findByRole('button', { expanded: false }));
  return user;
}

const buttonsIn = (group: HTMLElement) =>
  within(group).getAllByRole('button').map((b) => b.textContent);

it('a rank-40 writer picks between Everyone and Internal, with the clients hint', async () => {
  api.listNotes.mockResolvedValue([]);
  api.listAttachments.mockResolvedValue([]);
  await openPanel();

  const group = screen.getByRole('group', { name: 'Visible to' });
  expect(buttonsIn(group)).toEqual(['Everyone', 'Internal']);
  expect(within(group).getByRole('button', { name: 'Everyone' }).getAttribute('aria-pressed'))
    .toBe('true');
  expect(within(group).getByRole('button', { name: 'Internal' }).getAttribute('aria-pressed'))
    .toBe('false');
  expect(screen.getByText(HINT)).toBeDefined();
});

it('a rank-60 writer is offered Admin; the chosen level goes with the note and the upload', async () => {
  auth.maxRank = 60;
  api.listNotes.mockResolvedValue([]);
  api.listAttachments.mockResolvedValue([]);
  api.createNote.mockResolvedValue(note('new'));
  api.uploadAttachmentRequest.mockResolvedValue(attachment({}));
  const user = await openPanel();

  const group = screen.getByRole('group', { name: 'Visible to' });
  expect(buttonsIn(group)).toEqual(['Everyone', 'Internal', 'Admin']);

  await user.click(within(group).getByRole('button', { name: 'Internal' }));
  await user.type(screen.getByPlaceholderText('Add a note…'), 'Gate code is 4411');
  await user.click(screen.getByRole('button', { name: 'Add note' }));
  await waitFor(() => expect(api.createNote)
    .toHaveBeenCalledWith('site', 'site-1', 'Gate code is 4411', 'internal'));

  // the chosen level sticks after a save
  expect(within(screen.getByRole('group', { name: 'Visible to' }))
    .getByRole('button', { name: 'Internal' }).getAttribute('aria-pressed')).toBe('true');

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const pdf = new File(['x'], 'plan.pdf', { type: 'application/pdf' });
  await user.upload(input, pdf);
  await waitFor(() => expect(api.uploadAttachmentRequest).toHaveBeenCalledWith({
    entityType: 'site', entityId: 'site-1', kind: 'document', file: pdf, visibility: 'internal',
  }));
});

it('a reader sees no picker', async () => {
  api.listNotes.mockResolvedValue([note('n1')]);
  api.listAttachments.mockResolvedValue([]);
  await openPanel(false);

  expect(screen.queryByRole('group', { name: 'Visible to' })).toBeNull();
  expect(screen.queryByText(HINT)).toBeNull();
});

it('a client-scoped writer sees no picker (Everyone is the only level)', async () => {
  auth.scope = { global: false, client_ids: ['c1'], partner_ids: [] };
  api.listNotes.mockResolvedValue([]);
  api.listAttachments.mockResolvedValue([]);
  await openPanel();

  expect(screen.queryByRole('group', { name: 'Visible to' })).toBeNull();
});

it('shows Internal / Admin chips on notes, file rows and thumbnails, none for Everyone', async () => {
  api.listNotes.mockResolvedValue([
    note('n-int', { visibility: 'internal', created_at: '2026-08-05T00:00:00Z' }),
    note('n-all', { created_at: '2026-08-04T00:00:00Z' }),
  ]);
  api.listAttachments.mockResolvedValue([
    attachment({ id: 'doc-adm', filename: 'budget.pdf', visibility: 'admin' }),
    attachment({ id: 'doc-all', filename: 'open.pdf', visibility: 'everyone' }),
    attachment({ id: 'img-int', filename: 'rack.png', content_type: 'image/png',
                 url: 'https://x/rack.png', visibility: 'internal' }),
  ]);
  await openPanel(false);

  const noteInt = screen.getByText('Note n-int').closest('li') as HTMLElement;
  expect(within(noteInt).getByText('Internal', { selector: '.chip' })).toBeDefined();
  const noteAll = screen.getByText('Note n-all').closest('li') as HTMLElement;
  expect(noteAll.querySelector('.chip')).toBeNull();

  const docAdm = screen.getByText(/📎 budget\.pdf/).closest('li') as HTMLElement;
  expect(within(docAdm).getByText('Admin', { selector: '.chip' })).toBeDefined();
  const docAll = screen.getByText(/📎 open\.pdf/).closest('li') as HTMLElement;
  expect(within(docAll).queryByText('Admin', { selector: '.chip' })).toBeNull();
  expect(within(docAll).queryByText('Internal', { selector: '.chip' })).toBeNull();

  const cap = screen.getByText('rack.png', { selector: '.nf-thumb-cap *' })
    .closest('.nf-thumb-wrap') as HTMLElement;
  expect(within(cap).getByText('Internal', { selector: '.chip' })).toBeDefined();
});

it('editing a note presets its level and saves body and visibility together', async () => {
  api.listNotes.mockResolvedValue([note('n1', { visibility: 'internal' })]);
  api.listAttachments.mockResolvedValue([]);
  api.updateNote.mockResolvedValue(note('n1'));
  const user = await openPanel();

  await user.click(screen.getByRole('button', { name: 'Edit' }));
  const group = screen.getByRole('group', { name: 'Note visibility' });
  expect(within(group).getByRole('button', { name: 'Internal' }).getAttribute('aria-pressed'))
    .toBe('true');

  await user.click(within(group).getByRole('button', { name: 'Everyone' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateNote)
    .toHaveBeenCalledWith('n1', { body: 'Note n1', visibility: 'everyone' }));
});

it('a file row\'s Visibility button opens the picker and saves the new level', async () => {
  api.listNotes.mockResolvedValue([]);
  api.listAttachments.mockResolvedValue([
    attachment({ id: 'doc-1', filename: 'manual.pdf' }),
    attachment({ id: 'av-1', filename: 'me.png', kind: 'avatar', content_type: 'image/png',
                 url: 'https://x/me.png' }),
  ]);
  api.updateAttachment.mockResolvedValue(attachment({ visibility: 'internal' }));
  const user = await openPanel();

  // an avatar never gets the button; the document does
  expect(screen.getAllByRole('button', { name: 'Visibility' })).toHaveLength(1);

  await user.click(screen.getByRole('button', { name: 'Visibility' }));
  const group = screen.getByRole('group', { name: 'File visibility' });

  // no call when the level is unchanged
  await user.click(within(group).getByRole('button', { name: 'Everyone' }));
  expect(api.updateAttachment).not.toHaveBeenCalled();

  api.listAttachments.mockClear();
  await user.click(within(screen.getByRole('group', { name: 'File visibility' }))
    .getByRole('button', { name: 'Internal' }));
  await waitFor(() => expect(api.updateAttachment)
    .toHaveBeenCalledWith('doc-1', { visibility: 'internal' }));
  await waitFor(() => expect(api.listAttachments).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole('group', { name: 'File visibility' })).toBeNull());
});

it('thumbnails get the Visibility button too', async () => {
  api.listNotes.mockResolvedValue([]);
  api.listAttachments.mockResolvedValue([
    attachment({ id: 'img-1', filename: 'rack.png', content_type: 'image/png',
                 url: 'https://x/rack.png', kind: 'photo' }),
  ]);
  api.updateAttachment.mockResolvedValue(attachment({}));
  const user = await openPanel();

  await user.click(screen.getByRole('button', { name: 'Visibility' }));
  await user.click(within(screen.getByRole('group', { name: 'File visibility' }))
    .getByRole('button', { name: 'Internal' }));
  await waitFor(() => expect(api.updateAttachment)
    .toHaveBeenCalledWith('img-1', { visibility: 'internal' }));
});

it('maps a visibility_not_allowed 403 to a plain message', async () => {
  api.listNotes.mockResolvedValue([]);
  api.listAttachments.mockResolvedValue([]);
  api.createNote.mockRejectedValue(new ApiError(403, 'visibility_not_allowed'));
  const user = await openPanel();

  await user.type(screen.getByPlaceholderText('Add a note…'), 'hello');
  await user.click(screen.getByRole('button', { name: 'Add note' }));
  expect(await screen.findByText("You can't choose that visibility.")).toBeDefined();
});
