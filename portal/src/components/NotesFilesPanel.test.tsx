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

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AttachmentOut, NoteOut } from '../lib/api';

const api = vi.hoisted(() => ({
  listNotes: vi.fn(),
  listAttachments: vi.fn(),
  uploadAttachmentRequest: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

function note(id: string): NoteOut {
  return {
    id, entity_type: 'site', entity_id: 'site-1', body: `Note ${id}`,
    created_by: null, author_name: 'Someone',
    created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
  };
}

function attachment(over: Partial<AttachmentOut>): AttachmentOut {
  return {
    id: 'file-1', entity_type: 'site', entity_id: 'site-1', kind: 'document',
    storage_key: 'k', filename: 'report.pdf', content_type: 'application/pdf',
    size_bytes: 2048, created_at: '2026-08-01T00:00:00Z', url: 'https://x/report.pdf',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
    entityType: 'partner', entityId: 'p1', kind: 'document', file: pdf,
  }));

  const png = new File(['x'], 'site.png', { type: 'image/png' });
  await user.upload(input, png);
  await waitFor(() => expect(api.uploadAttachmentRequest).toHaveBeenCalledWith({
    entityType: 'partner', entityId: 'p1', kind: 'photo', file: png,
  }));
});
