// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getNodePermissions: vi.fn(),
  putNodePermissions: vi.fn(),
  getSpaceGrants: vi.fn(),
  putSpaceGrants: vi.fn(),
  searchPrincipals: vi.fn(),
  getTree: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import { resetTreeStore } from '../lib/treeStore';
import type { NodePermissionsOut } from '../lib/types';
import {
  getNodePermissions, getSpaceGrants, getTree, putNodePermissions, putSpaceGrants, searchPrincipals,
} from '../lib/wikiApi';
import { makeNode, makeSpace } from '../testing/fixtures';
import PermissionsDialog, { PermissionsEditor } from './PermissionsDialog';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const NODE = makeNode('n1', { title: 'Rack power', my_level: 'manage', parent_id: 'f1' });

const PERMS: NodePermissionsOut = {
  inherit: true,
  grants: [{
    id: 'g-own', principal_type: 'person', principal_id: 'p-9', level: 'manage',
    principal_label: 'Grace Hopper', node_id: 'n1',
  }],
  effective: [
    { principal_type: 'internal', principal_id: null, level: 'view', principal_label: 'All internal staff',
      source: { kind: 'space', node_id: null, title: null } },
    { principal_type: 'role', principal_id: 'staff', level: 'edit', principal_label: 'Staff',
      source: { kind: 'node', node_id: 'f1', title: 'Guides' } },
    { principal_type: 'person', principal_id: 'p-9', level: 'manage', principal_label: 'Grace Hopper',
      source: { kind: 'node', node_id: 'n1', title: 'Rack power' } },
  ],
};

beforeEach(() => {
  resetTreeStore();
  toast.mockReset();
  vi.mocked(getTree).mockResolvedValue([]);
  vi.mocked(getNodePermissions).mockReset().mockResolvedValue(PERMS);
  vi.mocked(putNodePermissions).mockReset().mockResolvedValue(PERMS);
  vi.mocked(getSpaceGrants).mockReset();
  vi.mocked(putSpaceGrants).mockReset();
  vi.mocked(searchPrincipals).mockReset().mockImplementation(async (type, q) => (
    type === 'person' && (!q || 'ada lovelace'.includes(q.toLowerCase()))
      ? [{ type: 'person', id: 'p-2', label: 'Ada Lovelace' }]
      : []));
});
afterEach(cleanup);

/** Picks `label` in the ComboBox named `name`. */
function pick(name: string, label: string) {
  fireEvent.focus(screen.getByRole('combobox', { name }));
  fireEvent.mouseDown(screen.getByRole('button', { name: label }));
}

function rowFor(label: string): HTMLElement {
  return screen.getByText(label, { selector: '.wiki-perm-who b' }).closest('[role="listitem"]') as HTMLElement;
}

describe('PermissionsDialog — a page', () => {
  it('lists current access with where each entry comes from', async () => {
    render(<PermissionsDialog target={{ kind: 'node', node: NODE }} onClose={() => {}} />);
    expect(await screen.findByText('All internal staff', { selector: '.wiki-perm-who b' })).toBeTruthy();
    expect(within(rowFor('All internal staff')).getByText('Space')).toBeTruthy();
    expect(within(rowFor('Staff')).getByText('Inherited from Guides')).toBeTruthy();
    expect(within(rowFor('Grace Hopper')).getByText('This page')).toBeTruthy();
    // only the page's own entries can be removed
    expect(within(rowFor('Grace Hopper')).getByRole('button', { name: 'Remove Grace Hopper' })).toBeTruthy();
    expect(within(rowFor('Staff')).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Inherit permissions from parent' })).toHaveProperty('checked', true);
  });

  it('adds a person and saves the page\'s own grants', async () => {
    const onClose = vi.fn();
    render(<PermissionsDialog target={{ kind: 'node', node: NODE }} onClose={onClose} />);
    await screen.findByText('Grace Hopper', { selector: '.wiki-perm-who b' });

    pick('Principal type', 'Person');
    fireEvent.focus(screen.getByRole('combobox', { name: 'Who' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Who' }), { target: { value: 'ada' } });
    await waitFor(() => expect(searchPrincipals).toHaveBeenCalledWith('person', 'ada'));
    fireEvent.mouseDown(await screen.findByRole('button', { name: 'Ada Lovelace' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Level to add' })).getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(within(rowFor('Ada Lovelace')).getByText('This page')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putNodePermissions).toHaveBeenCalled());
    expect(putNodePermissions).toHaveBeenCalledWith('n1', {
      inherit: true,
      grants: [
        { principal_type: 'person', principal_id: 'p-9', level: 'manage' },
        { principal_type: 'person', principal_id: 'p-2', level: 'edit' },
      ],
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith('Permissions saved.');
  });

  it('adds everyone who can sign in without asking who', async () => {
    render(<PermissionsDialog target={{ kind: 'node', node: NODE }} onClose={() => {}} />);
    await screen.findByText('Grace Hopper', { selector: '.wiki-perm-who b' });
    pick('Principal type', 'Everyone who can sign in');
    expect(screen.queryByRole('combobox', { name: 'Who' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putNodePermissions).toHaveBeenCalled());
    expect(vi.mocked(putNodePermissions).mock.calls[0][1].grants).toContainEqual(
      { principal_type: 'everyone', principal_id: null, level: 'view' });
  });

  it('turning inheritance off explains the copy and sends {inherit: false}', async () => {
    render(<PermissionsDialog target={{ kind: 'node', node: NODE }} onClose={() => {}} />);
    await screen.findByText('Grace Hopper', { selector: '.wiki-perm-who b' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Inherit permissions from parent' }));
    expect(screen.getByText('Current access will be copied here so nothing changes until you edit it.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putNodePermissions).toHaveBeenCalledWith('n1', { inherit: false }));
  });

  it('shows a lock-out refusal inline', async () => {
    vi.mocked(putNodePermissions).mockRejectedValue(
      new ApiError(422, 'would_lock_out', undefined, 'This change would remove your own manage access to this page.'));
    render(<PermissionsDialog target={{ kind: 'node', node: NODE }} onClose={() => {}} />);
    await screen.findByText('Grace Hopper', { selector: '.wiki-perm-who b' });
    fireEvent.click(within(rowFor('Grace Hopper')).getByRole('button', { name: 'Remove Grace Hopper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('This change would remove your own manage access to this page.')).toBeTruthy();
  });
});

describe('PermissionsEditor — a space', () => {
  it('shows a no_manager refusal inline', async () => {
    vi.mocked(getSpaceGrants).mockResolvedValue([{
      id: 'g1', principal_type: 'person', principal_id: 'p-1', level: 'manage',
      principal_label: 'Jimmy Henderson', node_id: null,
    }]);
    vi.mocked(putSpaceGrants).mockRejectedValue(new ApiError(422, 'no_manager'));
    render(<PermissionsEditor target={{ kind: 'space', space: makeSpace({ my_level: 'manage' }) }} />);
    await screen.findByText('Jimmy Henderson', { selector: '.wiki-perm-who b' });
    const level = within(rowFor('Jimmy Henderson')).getByRole('group', { name: 'Level for Jimmy Henderson' });
    fireEvent.click(within(level).getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpaceGrants).toHaveBeenCalledWith('ops', [
      { principal_type: 'person', principal_id: 'p-1', level: 'edit' },
    ]));
    expect(await screen.findByText(/at least one/i)).toBeTruthy();
  });
});
