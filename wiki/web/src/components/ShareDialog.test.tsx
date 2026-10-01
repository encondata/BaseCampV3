// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getSpace: vi.fn(),
  listShareLinks: vi.fn(),
  createShareLink: vi.fn(),
  revokeShareLink: vi.fn(),
}));

import type { ShareLinkOut } from '../lib/types';
import { createShareLink, getSpace, listShareLinks, revokeShareLink } from '../lib/wikiApi';
import { makeNode, makeSpace } from '../testing/fixtures';
import ShareDialog from './ShareDialog';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const PUBLISHED = { is_home: false, published_version_id: 'v1', published_at: '2026-09-20T12:00:00Z', has_unpublished_changes: false, doc_type: null };
const NODE = makeNode('n1', { title: 'Rack Guide', my_level: 'manage', page: PUBLISHED });

function link(over: Partial<ShareLinkOut> = {}): ShareLinkOut {
  return {
    id: 'l1',
    node: { id: 'n1', title: 'Rack Guide', kind: 'page', space_key: 'ops', space_name: 'Operations' },
    status: 'active',
    created_by: { id: 'p-1', name: 'Jimmy Henderson' },
    created_at: '2026-09-20T12:00:00Z',
    expires_at: '2026-10-20T12:00:00Z',
    revoked_at: null,
    view_count: 4,
    last_viewed_at: null,
    ...over,
  };
}

function renderDialog(node = NODE, onClose = vi.fn()) {
  render(<MemoryRouter><ShareDialog node={node} onClose={onClose} /></MemoryRouter>);
  return onClose;
}

beforeEach(() => {
  toast.mockReset();
  vi.mocked(getSpace).mockReset().mockResolvedValue(
    makeSpace({ my_level: 'manage', settings: { allow_public_links: true } }));
  vi.mocked(listShareLinks).mockReset().mockResolvedValue([]);
  vi.mocked(createShareLink).mockReset();
  vi.mocked(revokeShareLink).mockReset();
});
afterEach(cleanup);

describe('ShareDialog', () => {
  it('creates a link with the chosen expiry and shows it once to copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.mocked(createShareLink).mockResolvedValue({ id: 'l9', url: 'https://wiki.test/p/secret-token', expires_at: null });
    vi.mocked(listShareLinks).mockResolvedValueOnce([])
      .mockResolvedValueOnce([link({ id: 'l9', expires_at: null, view_count: 0 })]);
    renderDialog();

    const expiry = await screen.findByRole('combobox', { name: 'Link expires' });
    expect(expiry).toHaveProperty('value', 'In 30 days');
    fireEvent.focus(expiry);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Never' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));

    await waitFor(() => expect(createShareLink).toHaveBeenCalledWith('n1', null));
    const field = await screen.findByLabelText('New public link');
    expect(field).toHaveProperty('value', 'https://wiki.test/p/secret-token');
    expect(screen.getByText(/won’t be shown again/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('https://wiki.test/p/secret-token');
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Link copied.'));
    // the list reloads — and never shows a token
    expect(await screen.findByText('Never expires')).toBeTruthy();
  });

  it('lists active and expired links, not revoked ones, and revokes', async () => {
    vi.mocked(listShareLinks).mockResolvedValue([
      link({ id: 'l1' }),
      link({ id: 'l2', status: 'expired', expires_at: '2026-09-01T00:00:00Z', view_count: 1 }),
      link({ id: 'l3', status: 'revoked', revoked_at: '2026-09-02T00:00:00Z' }),
    ]);
    vi.mocked(revokeShareLink).mockResolvedValue(undefined);
    renderDialog();
    const list = await screen.findByRole('list', { name: 'Public links' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('4 views')).toBeTruthy();
    expect(within(rows[1]).getByText('Expired')).toBeTruthy();
    expect(within(rows[1]).getByText('1 view')).toBeTruthy();

    vi.mocked(listShareLinks).mockResolvedValue([link({ id: 'l1', status: 'revoked', revoked_at: '2026-09-26T00:00:00Z' })]);
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith('l1'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Link revoked. It stops working right away.'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull());
  });

  it('explains when the space has public links turned off, with the way to turn them on for a space manager', async () => {
    vi.mocked(getSpace).mockResolvedValue(makeSpace({ my_level: 'manage', settings: {} }));
    const onClose = renderDialog();
    expect(await screen.findByText('Public links are turned off for this library.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create link' })).toBeNull();
    const settings = screen.getByRole('link', { name: 'Library settings' });
    expect(settings.getAttribute('href')).toBe('/library/ops/settings');
    fireEvent.click(settings);
    expect(onClose).toHaveBeenCalled();
  });

  it('points someone who can’t manage the space to a space manager', async () => {
    vi.mocked(getSpace).mockResolvedValue(makeSpace({ my_level: 'edit', settings: {} }));
    renderDialog();
    expect(await screen.findByText('Public links are turned off for this library.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Library settings' })).toBeNull();
    expect(screen.getByText(/Ask a library manager/)).toBeTruthy();
  });

  it('warns that a never-published page won’t open until it is published', async () => {
    renderDialog(makeNode('n1', { title: 'Draft only', my_level: 'manage' }));
    expect(await screen.findByText(/hasn’t been published yet/)).toBeTruthy();
  });

  it('says an archived space\'s links keep working until a wiki admin revokes them', async () => {
    vi.mocked(getSpace).mockResolvedValue(makeSpace({
      my_level: 'manage', archived_at: '2026-09-25T00:00:00Z', settings: { allow_public_links: true } }));
    renderDialog();
    expect(await screen.findByText(/This library is archived: its public links keep working/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Admin page' }).getAttribute('href')).toBe('/admin');
  });

  it('says nothing about an archived space\'s links when public links are off there', async () => {
    vi.mocked(getSpace).mockResolvedValue(makeSpace({
      my_level: 'manage', archived_at: '2026-09-25T00:00:00Z', settings: {} }));
    renderDialog();
    expect(await screen.findByText('Public links are turned off for this library.')).toBeTruthy();
    expect(screen.queryByText(/public links keep working/)).toBeNull();
  });

  it('reports a failed create', async () => {
    vi.mocked(createShareLink).mockRejectedValue(new Error('nope'));
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }));
    expect(await screen.findByText('Couldn’t create the link. Try again.')).toBeTruthy();
  });
});
