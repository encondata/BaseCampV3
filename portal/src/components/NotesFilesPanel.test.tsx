// @vitest-environment jsdom
/**
 * NotesFilesPanel: collapsed-by-default with a live badge, and the
 * image-attachment thumbnail/lightbox split (V2 parity) — image
 * attachments move out of the plain 📎 row list into a thumbnail grid,
 * and clicking a thumbnail opens a full-size lightbox that closes on
 * Escape or a scrim click. Also covers the Site & Move Survey additions:
 * a partner-only Document/Survey template upload-type choice and the
 * "Survey template" kind chip.
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

it('shows the Document/Survey template segmented control only for partners', async () => {
  const user = userEvent.setup();
  api.listNotes.mockResolvedValue([]);
  api.listAttachments.mockResolvedValue([]);

  render(<NotesFilesPanel entityType="partner" entityId="p1" canWrite />);
  await user.click(await screen.findByRole('button', { expanded: false }));
  expect(screen.getByRole('tab', { name: 'Document' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Survey template' })).toBeTruthy();
  cleanup();

  render(<NotesFilesPanel entityType="asset" entityId="a1" canWrite />);
  await user.click(await screen.findByRole('button', { expanded: false }));
  expect(screen.getByPlaceholderText('Add a note…')).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'Survey template' })).toBeNull();
});

it('uploading with Survey template selected sends kind survey_template and restricts to xlsx', async () => {
  const user = userEvent.setup();
  api.listNotes.mockResolvedValue([]);
  api.listAttachments.mockResolvedValue([]);
  api.uploadAttachmentRequest.mockResolvedValue(
    attachment({ id: 'f2', kind: 'survey_template', filename: 'survey.xlsx' }));

  render(<NotesFilesPanel entityType="partner" entityId="p1" canWrite />);
  await user.click(await screen.findByRole('button', { expanded: false }));
  await user.click(screen.getByRole('tab', { name: 'Survey template' }));

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input.accept).toBe('.xlsx');
  const xlsx = new File(['x'], 'survey.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  await user.upload(input, xlsx);

  await waitFor(() => expect(api.uploadAttachmentRequest).toHaveBeenCalledWith({
    entityType: 'partner', entityId: 'p1', kind: 'survey_template', file: xlsx,
  }));
});

it('defaults to Document, and a plain document upload still works', async () => {
  const user = userEvent.setup();
  api.listNotes.mockResolvedValue([]);
  api.listAttachments.mockResolvedValue([]);
  api.uploadAttachmentRequest.mockResolvedValue(attachment({}));

  render(<NotesFilesPanel entityType="partner" entityId="p1" canWrite />);
  await user.click(await screen.findByRole('button', { expanded: false }));
  expect(screen.getByRole('tab', { name: 'Document' }).className).toContain('on');

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const pdf = new File(['x'], 'contract.pdf', { type: 'application/pdf' });
  await user.upload(input, pdf);

  await waitFor(() => expect(api.uploadAttachmentRequest).toHaveBeenCalledWith({
    entityType: 'partner', entityId: 'p1', kind: 'document', file: pdf,
  }));
});

it('shows a "Survey template" chip on survey_template rows', async () => {
  const user = userEvent.setup();
  api.listNotes.mockResolvedValue([]);
  api.listAttachments.mockResolvedValue([
    attachment({ id: 'f2', kind: 'survey_template', filename: 'survey.xlsx', url: null }),
  ]);

  render(<NotesFilesPanel entityType="partner" entityId="p1" canWrite />);
  await user.click(await screen.findByRole('button', { expanded: false }));
  expect(await screen.findByText('Survey template', { selector: 'span.chip' })).toBeTruthy();
});
