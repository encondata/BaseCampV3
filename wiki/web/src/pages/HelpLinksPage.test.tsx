// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ person: { id: 'p-1' } }) }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getMe: vi.fn(),
  getNode: vi.fn(),
  search: vi.fn(),
  listHelpLinks: vi.fn(),
  createHelpLink: vi.fn(),
  updateHelpLink: vi.fn(),
  deleteHelpLink: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import { clearWikiMe } from '../lib/useWikiMe';
import type { HelpLinkOut } from '../lib/types';
import {
  createHelpLink, deleteHelpLink, getMe, getNode, listHelpLinks, search, updateHelpLink,
} from '../lib/wikiApi';
import { makeDetail, makeMe, makeSearchHit } from '../testing/fixtures';
import HelpLinksPage from './HelpLinksPage';

function link(over: Partial<HelpLinkOut> = {}): HelpLinkOut {
  return {
    id: 'h1',
    context: 'portal:/bulk/time',
    node: { id: 'n1', title: 'Time Guide', kind: 'page', space_key: 'ops', space_name: 'Operations' },
    trashed: false,
    created_by: { id: 'p-1', name: 'Jimmy Henderson' },
    created_at: '2026-09-20T12:00:00Z',
    ...over,
  };
}

function renderAt(url = '/admin/help-links', admin = true) {
  vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: admin }));
  return render(<MemoryRouter initialEntries={[url]}><HelpLinksPage /></MemoryRouter>);
}

/** Search the guide ComboBox and pick a hit. */
async function pickGuide(query: string, title: string) {
  const box = screen.getByRole('combobox', { name: 'Guide' });
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: query } });
  fireEvent.mouseDown(await screen.findByRole('button', { name: new RegExp(`^${title}`) }));
}

beforeEach(() => {
  clearWikiMe();
  toast.mockReset();
  vi.mocked(listHelpLinks).mockReset().mockResolvedValue([]);
  vi.mocked(createHelpLink).mockReset();
  vi.mocked(updateHelpLink).mockReset();
  vi.mocked(deleteHelpLink).mockReset();
  vi.mocked(getNode).mockReset();
  vi.mocked(search).mockReset().mockResolvedValue([]);
});
afterEach(cleanup);

describe('HelpLinksPage', () => {
  it('is not found for a non-admin', async () => {
    renderAt('/admin/help-links', false);
    expect(await screen.findByText('Nothing here')).toBeTruthy();
    expect(listHelpLinks).not.toHaveBeenCalled();
  });

  it('lists every link with its guide, flagging one in the trash', async () => {
    vi.mocked(listHelpLinks).mockResolvedValue([
      link(),
      link({ id: 'h2', context: 'kiosk:/enroll', trashed: true,
        node: { id: 'f1', title: 'manual.pdf', kind: 'file', space_key: 'ops', space_name: 'Operations' } }),
    ]);
    renderAt();
    const list = await screen.findByRole('list', { name: 'Help links' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('portal:/bulk/time')).toBeTruthy();
    expect(within(rows[0]).getByRole('link', { name: 'Time Guide' }).getAttribute('href')).toBe('/n/n1');
    expect(within(rows[0]).queryByText('In trash')).toBeNull();
    expect(within(rows[1]).getByText('In trash')).toBeTruthy();
  });

  it('shows an empty state', async () => {
    renderAt();
    expect(await screen.findByText('No help links yet')).toBeTruthy();
  });

  it('adds a link: context and a searched guide', async () => {
    vi.mocked(search).mockResolvedValue([
      makeSearchHit({ node: { id: 'n9', kind: 'page', title: 'Enroll Guide', space_key: 'ops', space_name: 'Operations' } }),
      makeSearchHit({ node: { id: 'd1', kind: 'folder', title: 'Enroll Folder', space_key: 'ops', space_name: 'Operations' } }),
    ]);
    const created = link({ id: 'h9', context: 'kiosk:/enroll',
      node: { id: 'n9', title: 'Enroll Guide', kind: 'page', space_key: 'ops', space_name: 'Operations' } });
    vi.mocked(createHelpLink).mockResolvedValue(created);
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Add help link' }));
    const dialog = screen.getByRole('dialog', { name: 'Add help link' });
    fireEvent.change(within(dialog).getByLabelText('Context'), { target: { value: 'kiosk:/enroll' } });
    await pickGuide('enroll', 'Enroll Guide');
    // folders can't be guides
    expect(screen.queryByRole('button', { name: /^Enroll Folder/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add link' }));
    await waitFor(() => expect(createHelpLink).toHaveBeenCalledWith({ context: 'kiosk:/enroll', node_id: 'n9' }));
    expect(await screen.findByText('kiosk:/enroll')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toast).toHaveBeenCalledWith('Help link added.');
  });

  it('keeps the dialog open with the server’s message when the context is taken', async () => {
    vi.mocked(search).mockResolvedValue([makeSearchHit()]);
    vi.mocked(createHelpLink).mockRejectedValue(
      new ApiError(409, 'context_taken', undefined, 'Another help link already uses that context.'));
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Add help link' }));
    fireEvent.change(screen.getByLabelText('Context'), { target: { value: 'portal:/bulk/time' } });
    await pickGuide('rack', 'Rack power');
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(await screen.findByText('Another help link already uses that context.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Add help link' })).toBeTruthy();
  });

  it('can’t save without a context and a guide', async () => {
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Add help link' }));
    const save = screen.getByRole('button', { name: 'Add link' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Context'), { target: { value: 'portal:/assets' } });
    expect(save.disabled).toBe(true);
  });

  it('opens the add form with the context from ?context= (the portal’s “Link a guide”)', async () => {
    renderAt('/admin/help-links?context=portal%3A%2Fbulk%2Ftime');
    const dialog = await screen.findByRole('dialog', { name: 'Add help link' });
    expect((within(dialog).getByLabelText('Context') as HTMLInputElement).value).toBe('portal:/bulk/time');
  });

  it('opens the add form with the guide from ?node= (the page’s “Use as help for…”)', async () => {
    vi.mocked(getNode).mockResolvedValue(makeDetail('n5', { title: 'Scanning Guide' }));
    vi.mocked(createHelpLink).mockResolvedValue(link({ id: 'h5', context: 'kiosk:/scan' }));
    renderAt('/admin/help-links?node=n5');
    const dialog = await screen.findByRole('dialog', { name: 'Add help link' });
    await waitFor(() => expect((within(dialog).getByRole('combobox', { name: 'Guide' }) as HTMLInputElement)
      .value).toBe('Scanning Guide'));
    expect(getNode).toHaveBeenCalledWith('n5');
    fireEvent.change(within(dialog).getByLabelText('Context'), { target: { value: 'kiosk:/scan' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add link' }));
    await waitFor(() => expect(createHelpLink).toHaveBeenCalledWith({ context: 'kiosk:/scan', node_id: 'n5' }));
  });

  it('edits a link, sending only what changed', async () => {
    vi.mocked(listHelpLinks).mockResolvedValue([link()]);
    vi.mocked(updateHelpLink).mockResolvedValue(link({ context: 'portal:/bulk' }));
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit help link' });
    const context = within(dialog).getByLabelText('Context') as HTMLInputElement;
    expect(context.value).toBe('portal:/bulk/time');
    fireEvent.change(context, { target: { value: 'portal:/bulk' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateHelpLink).toHaveBeenCalledWith('h1', { context: 'portal:/bulk' }));
    expect(await screen.findByText('portal:/bulk')).toBeTruthy();
  });

  it('deletes a link after confirming', async () => {
    vi.mocked(listHelpLinks).mockResolvedValue([link()]);
    vi.mocked(deleteHelpLink).mockResolvedValue(undefined);
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete link' }));
    await waitFor(() => expect(deleteHelpLink).toHaveBeenCalledWith('h1'));
    expect(await screen.findByText('No help links yet')).toBeTruthy();
  });
});
