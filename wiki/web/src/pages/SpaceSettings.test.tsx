// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ person: { id: 'p-1' } }) }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getMe: vi.fn(),
  getSpace: vi.fn(),
  updateSpace: vi.fn(),
  archiveSpace: vi.fn(),
  unarchiveSpace: vi.fn(),
  getSpaceGrants: vi.fn(),
  putSpaceGrants: vi.fn(),
  searchPrincipals: vi.fn(),
  getTree: vi.fn(),
}));

import { ShellContext, type ShellValue } from '../layout/shellContext';
import { resetTreeStore } from '../lib/treeStore';
import type { SpaceOut } from '../lib/types';
import { clearWikiMe } from '../lib/useWikiMe';
import {
  archiveSpace, getMe, getSpace, getSpaceGrants, getTree, unarchiveSpace, updateSpace,
} from '../lib/wikiApi';
import { makeMe, makeSpace } from '../testing/fixtures';
import SpaceSettings from './SpaceSettings';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

function renderSettings(space: SpaceOut, admin = false) {
  vi.mocked(getSpace).mockResolvedValue(space);
  vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: admin }));
  return render(
    <MemoryRouter initialEntries={[`/library/${space.key}/settings`]}>
      <Routes><Route path="/library/:spaceKey/settings" element={<SpaceSettings />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearWikiMe();
  resetTreeStore();
  toast.mockReset();
  vi.mocked(getTree).mockResolvedValue([]);
  vi.mocked(getSpaceGrants).mockReset().mockResolvedValue([{
    id: 'g1', principal_type: 'person', principal_id: 'p-1', level: 'manage',
    principal_label: 'Jimmy Henderson', node_id: null,
  }]);
  vi.mocked(updateSpace).mockReset();
  vi.mocked(archiveSpace).mockReset();
  vi.mocked(unarchiveSpace).mockReset();
});
afterEach(cleanup);

describe('SpaceSettings', () => {
  it('saves the name, description, icon and color', async () => {
    const space = makeSpace({ my_level: 'manage' });
    vi.mocked(updateSpace).mockResolvedValue({ ...space, name: 'Field Ops' });
    renderSettings(space);
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Field Ops' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Moves and installs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(updateSpace).toHaveBeenCalledWith('ops', {
      name: 'Field Ops', description: 'Moves and installs', icon: '📘', color: '#1668a7',
    }));
    expect(toast).toHaveBeenCalledWith('Settings saved.');
  });

  it('does not start dirty when the space has no color set', async () => {
    renderSettings(makeSpace({ my_level: 'manage', color: null }));
    await screen.findByLabelText('Name');
    expect(screen.getByRole('button', { name: 'Save settings' })).toHaveProperty('disabled', true);
  });

  it('manages members inline on the page and links to the trash', async () => {
    renderSettings(makeSpace({ my_level: 'manage' }));
    const members = await screen.findByRole('region', { name: 'Members' });
    expect(await within(members).findByText('Jimmy Henderson')).toBeTruthy();
    expect(getSpaceGrants).toHaveBeenCalledWith('ops');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('link', { name: /Trash/ }).getAttribute('href')).toBe('/library/ops/trash');
  });

  it('exports the whole space through the shell', async () => {
    const space = makeSpace({ my_level: 'manage' });
    vi.mocked(getSpace).mockResolvedValue(space);
    vi.mocked(getMe).mockResolvedValue(makeMe());
    const requestExport = vi.fn();
    const shell = { setCurrentNode: vi.fn(), setCurrentSpace: vi.fn(), requestExport } as unknown as ShellValue;
    render(
      <ShellContext.Provider value={shell}>
        <MemoryRouter initialEntries={['/library/ops/settings']}>
          <Routes><Route path="/library/:spaceKey/settings" element={<SpaceSettings />} /></Routes>
        </MemoryRouter>
      </ShellContext.Provider>,
    );
    const section = await screen.findByRole('region', { name: 'Export' });
    fireEvent.click(within(section).getByRole('button', { name: 'Export library…' }));
    expect(requestExport).toHaveBeenCalledWith({ kind: 'space', space });
  });

  it('has no Export library… while the library\'s printing is off', async () => {
    renderSettings(makeSpace({ my_level: 'manage', settings: { allow_printing: false } }));
    const section = await screen.findByRole('region', { name: 'Export' });
    expect(within(section).queryByRole('button', { name: 'Export library…' })).toBeNull();
    expect(within(section).getByText('Printing is turned off for this library, so it can\'t be exported.')).toBeTruthy();
  });

  it('archives after a confirmation', async () => {
    const space = makeSpace({ my_level: 'manage' });
    vi.mocked(archiveSpace).mockResolvedValue({ ...space, archived_at: '2026-09-25T00:00:00Z', my_level: 'view' });
    renderSettings(space);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive library' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(archiveSpace).toHaveBeenCalledWith('ops'));
  });

  it('offers Unarchive to wiki admins only', async () => {
    const archived = makeSpace({ my_level: 'manage', archived_at: '2026-09-25T00:00:00Z' });
    vi.mocked(unarchiveSpace).mockResolvedValue({ ...archived, archived_at: null });
    renderSettings(archived, true);
    fireEvent.click(await screen.findByRole('button', { name: 'Unarchive library' }));
    await waitFor(() => expect(unarchiveSpace).toHaveBeenCalledWith('ops'));
    cleanup();
    clearWikiMe();
    renderSettings(makeSpace({ my_level: 'view', archived_at: '2026-09-25T00:00:00Z' }), false);
    expect(await screen.findByText('This library is archived.')).toBeTruthy();
    expect(screen.queryByText(/only library managers/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unarchive library' })).toBeNull();
  });

  it('tells a non-manager of an active space that only managers can change settings', async () => {
    renderSettings(makeSpace({ my_level: 'view' }));
    expect(await screen.findByText('Only library managers can change these settings.')).toBeTruthy();
    expect(screen.queryByText('This library is archived.')).toBeNull();
  });
});

describe('SpaceSettings — Collaboration', () => {
  it('defaults readers-can-comment on, approval off, and no review interval', async () => {
    renderSettings(makeSpace({ my_level: 'manage', settings: {} }));
    const section = await screen.findByRole('region', { name: 'Collaboration' });
    expect(within(section).getByLabelText('Readers can comment')).toHaveProperty('checked', true);
    expect(within(section).getByLabelText('Require approval to publish')).toHaveProperty('checked', false);
    expect(within(section).getByRole('combobox', { name: 'Review reminders' })).toHaveProperty('value', 'None');
  });

  it('reflects stored settings', async () => {
    renderSettings(makeSpace({
      my_level: 'manage',
      settings: { readers_can_comment: false, require_approval: true, review_interval_months: 6 },
    }));
    const section = await screen.findByRole('region', { name: 'Collaboration' });
    expect(within(section).getByLabelText('Readers can comment')).toHaveProperty('checked', false);
    expect(within(section).getByLabelText('Require approval to publish')).toHaveProperty('checked', true);
    expect(within(section).getByRole('combobox', { name: 'Review reminders' })).toHaveProperty('value', '6 months');
  });

  it('saves a toggle immediately, merging just that key', async () => {
    const space = makeSpace({ my_level: 'manage', settings: {} });
    vi.mocked(updateSpace).mockResolvedValue({ ...space, settings: { readers_can_comment: false } });
    renderSettings(space);
    const section = await screen.findByRole('region', { name: 'Collaboration' });
    fireEvent.click(within(section).getByLabelText('Readers can comment'));
    await waitFor(() => expect(updateSpace).toHaveBeenCalledWith('ops', { settings: { readers_can_comment: false } }));
  });

  it('saves the review interval, and clearing it back to None', async () => {
    const space = makeSpace({ my_level: 'manage', settings: {} });
    vi.mocked(updateSpace).mockResolvedValue({ ...space, settings: { review_interval_months: 12 } });
    renderSettings(space);
    const section = await screen.findByRole('region', { name: 'Collaboration' });
    fireEvent.focus(within(section).getByRole('combobox', { name: 'Review reminders' }));
    fireEvent.mouseDown(screen.getByRole('button', { name: '12 months' }));
    await waitFor(() => expect(updateSpace).toHaveBeenCalledWith('ops', { settings: { review_interval_months: 12 } }));
  });

  it('reports a failed save', async () => {
    vi.mocked(updateSpace).mockRejectedValue(new Error('nope'));
    renderSettings(makeSpace({ my_level: 'manage', settings: {} }));
    const section = await screen.findByRole('region', { name: 'Collaboration' });
    fireEvent.click(within(section).getByLabelText('Require approval to publish'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Couldn\'t save this setting. Try again.'));
  });

  it('turns public links on and off in the Sharing section (off by default)', async () => {
    const space = makeSpace({ my_level: 'manage', settings: {} });
    vi.mocked(updateSpace).mockResolvedValue({ ...space, settings: { allow_public_links: true } });
    renderSettings(space);
    const section = await screen.findByRole('region', { name: 'Sharing' });
    const toggle = within(section).getByLabelText('Allow public links');
    expect(toggle).toHaveProperty('checked', false);
    fireEvent.click(toggle);
    await waitFor(() => expect(updateSpace).toHaveBeenCalledWith('ops', { settings: { allow_public_links: true } }));
    await waitFor(() => expect(within(section).getByLabelText('Allow public links')).toHaveProperty('checked', true));
  });

  it('turns printing on and off in the Sharing section (on by default)', async () => {
    const space = makeSpace({ my_level: 'manage', settings: {} });
    vi.mocked(updateSpace).mockResolvedValue({ ...space, settings: { allow_printing: false } });
    renderSettings(space);
    const section = await screen.findByRole('region', { name: 'Sharing' });
    const toggle = within(section).getByLabelText('Allow printing');
    expect(toggle).toHaveProperty('checked', true);
    fireEvent.click(toggle);
    await waitFor(() => expect(updateSpace).toHaveBeenCalledWith('ops', { settings: { allow_printing: false } }));
    await waitFor(() => expect(within(section).getByLabelText('Allow printing')).toHaveProperty('checked', false));
  });

  it('sets the library\'s own confidentiality statement in the Sharing section', async () => {
    const space = makeSpace({ my_level: 'manage', settings: {} });
    vi.mocked(updateSpace).mockResolvedValue({ ...space, settings: { confidentiality_statement: 'Ours only' } });
    renderSettings(space);
    const section = await screen.findByRole('region', { name: 'Sharing' });
    const field = within(section).getByLabelText('Confidentiality statement') as HTMLTextAreaElement;
    expect(field.value).toBe('');
    expect(field.maxLength).toBe(1000);
    expect(within(section).getByText('Leave empty to use the standard statement.')).toBeTruthy();

    // blurring without a change saves nothing
    fireEvent.blur(field);
    expect(updateSpace).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: '  Ours only  ' } });
    fireEvent.blur(field);
    await waitFor(() => expect(updateSpace).toHaveBeenCalledWith('ops', {
      settings: { confidentiality_statement: 'Ours only' } }));
    await waitFor(() => expect(
      (within(section).getByLabelText('Confidentiality statement') as HTMLTextAreaElement).value).toBe('Ours only'));
  });

  it('shows a stored library statement, and clears it with an empty one', async () => {
    const space = makeSpace({ my_level: 'manage', settings: { confidentiality_statement: 'Ours only' } });
    vi.mocked(updateSpace).mockResolvedValue({ ...space, settings: { confidentiality_statement: '' } });
    renderSettings(space);
    const field = await screen.findByLabelText('Confidentiality statement') as HTMLTextAreaElement;
    expect(field.value).toBe('Ours only');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    await waitFor(() => expect(updateSpace).toHaveBeenCalledWith('ops', {
      settings: { confidentiality_statement: '' } }));
  });

  it('tells everyone that an archived space\'s public links keep working', async () => {
    renderSettings(makeSpace({
      my_level: 'view', archived_at: '2026-09-25T00:00:00Z', settings: { allow_public_links: true } }));
    expect(await screen.findByText(/public links keep working/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Admin page' }).getAttribute('href')).toBe('/admin');
  });

  it('says nothing about links for an archived space that never allowed them', async () => {
    renderSettings(makeSpace({ my_level: 'view', archived_at: '2026-09-25T00:00:00Z', settings: {} }));
    expect(await screen.findByText('This library is archived.')).toBeTruthy();
    expect(screen.queryByText(/public links keep working/)).toBeNull();
  });

  it('links to the space\'s pages due for review', async () => {
    renderSettings(makeSpace({ my_level: 'manage', settings: {} }));
    const section = await screen.findByRole('region', { name: 'Collaboration' });
    expect(within(section).getByRole('link', { name: 'Pages due for review' }).getAttribute('href')).toBe('/library/ops/due');
  });
});
