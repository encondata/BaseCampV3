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
  setNodePrivacy: vi.fn(),
  setNodePrinting: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import { loadChildren, resetTreeStore } from '../lib/treeStore';
import type { NodePermissionsOut } from '../lib/types';
import {
  getNodePermissions, getSpaceGrants, getTree, putNodePermissions, putSpaceGrants, searchPrincipals,
  setNodePrinting, setNodePrivacy,
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
  vi.mocked(setNodePrivacy).mockReset();
  vi.mocked(setNodePrinting).mockReset();
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
    expect(within(rowFor('All internal staff')).getByText('Library')).toBeTruthy();
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

  it('keeps Escape and the scrim from closing while a save is in flight, and ignores it landing after the dialog is gone', async () => {
    let resolveSave!: (v: NodePermissionsOut) => void;
    vi.mocked(putNodePermissions).mockImplementation(() => new Promise((r) => { resolveSave = r; }));
    const onClose = vi.fn();
    const { unmount } = render(<PermissionsDialog target={{ kind: 'node', node: NODE }} onClose={onClose} />);
    await screen.findByText('Grace Hopper', { selector: '.wiki-perm-who b' });
    fireEvent.click(within(rowFor('Grace Hopper')).getByRole('button', { name: 'Remove Grace Hopper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true);

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveProperty('disabled', true);

    // the dialog closes (unmounted) before the slow save comes back —
    // its result must not touch state that no longer exists
    unmount();
    resolveSave(PERMS);
    await Promise.resolve();
    await Promise.resolve();
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

const PRIVATE_LABEL = 'Private — only you and developers can see this';

describe('PermissionsDialog — Private', () => {
  it('shows the switch only when the caller can set it', async () => {
    const { unmount } = render(
      <PermissionsDialog target={{ kind: 'node', node: { ...NODE, can_set_private: false } }} onClose={() => {}} />);
    await screen.findByText('Grace Hopper', { selector: '.wiki-perm-who b' });
    expect(screen.queryByRole('checkbox', { name: PRIVATE_LABEL })).toBeNull();
    unmount();

    render(<PermissionsDialog target={{ kind: 'node', node: { ...NODE, can_set_private: true } }} onClose={() => {}} />);
    const toggle = await screen.findByRole('checkbox', { name: PRIVATE_LABEL });
    expect(toggle).toHaveProperty('checked', false);
    expect(screen.getByText(PRIVATE_LABEL, { selector: 'b' })).toBeTruthy();
  });

  it('shows a non-manager author only the Private switch', async () => {
    const author = { ...NODE, my_level: 'edit' as const, can_set_private: true };
    vi.mocked(setNodePrivacy).mockResolvedValue({ ...author, is_private: true, my_level: 'manage' });
    render(<PermissionsDialog target={{ kind: 'node', node: author }} onClose={() => {}} />);
    const toggle = await screen.findByRole('checkbox', { name: PRIVATE_LABEL });
    // no grants to load or edit, no inheritance, no Printing, no Save
    expect(getNodePermissions).not.toHaveBeenCalled();
    expect(screen.queryByRole('checkbox', { name: 'Inherit permissions from parent' })).toBeNull();
    expect(screen.queryByText('Add access')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Printing' })).toBeNull();
    expect(screen.queryByText('Printing')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.getByText(/can't have public links, help links or templates/)).toBeTruthy();

    fireEvent.click(toggle);
    await waitFor(() => expect(setNodePrivacy).toHaveBeenCalledWith('n1', true));
    // turning it on makes them a manager of the node, but the dialog keeps its layout
    await waitFor(() => expect(toggle).toHaveProperty('checked', true));
    expect(screen.queryByText('Add access')).toBeNull();
    expect(screen.queryByText('Printing')).toBeNull();
  });

  it('is not offered on a library\'s home page', async () => {
    const home = { ...NODE, can_set_private: true, page: { ...NODE.page!, is_home: true } };
    render(<PermissionsDialog target={{ kind: 'node', node: home }} onClose={() => {}} />);
    await screen.findByText('Grace Hopper', { selector: '.wiki-perm-who b' });
    expect(screen.queryByRole('checkbox', { name: PRIVATE_LABEL })).toBeNull();
  });

  it('saves a toggle at once, refreshes the tree, and keeps the dialog open', async () => {
    const onClose = vi.fn();
    vi.mocked(setNodePrivacy).mockResolvedValue({ ...NODE, can_set_private: true, is_private: true });
    await loadChildren('ops', 'f1');
    vi.mocked(getTree).mockClear();
    render(<PermissionsDialog target={{ kind: 'node', node: { ...NODE, can_set_private: true } }} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: PRIVATE_LABEL }));
    await waitFor(() => expect(setNodePrivacy).toHaveBeenCalledWith('n1', true));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: PRIVATE_LABEL })).toHaveProperty('checked', true));
    await waitFor(() => expect(getTree).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();

    vi.mocked(setNodePrivacy).mockResolvedValue({ ...NODE, can_set_private: true, is_private: false });
    fireEvent.click(screen.getByRole('checkbox', { name: PRIVATE_LABEL }));
    await waitFor(() => expect(setNodePrivacy).toHaveBeenLastCalledWith('n1', false));
  });

  it('shows a refusal in the dialog\'s error spot', async () => {
    vi.mocked(setNodePrivacy).mockRejectedValue(
      new ApiError(403, 'forbidden', undefined, 'Only the author or a developer can change this.'));
    render(<PermissionsDialog target={{ kind: 'node', node: { ...NODE, can_set_private: true } }} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: PRIVATE_LABEL }));
    expect(await screen.findByText('Only the author or a developer can change this.')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: PRIVATE_LABEL })).toHaveProperty('checked', false);
  });
});

describe('PermissionsDialog — Printing', () => {
  const HELP = 'This stops printing, exporting, downloading and public links. It can\'t stop screenshots.';

  it('is for managers only', async () => {
    render(<PermissionsDialog target={{ kind: 'node', node: { ...NODE, my_level: 'edit', can_set_private: true } }}
                              onClose={() => {}} />);
    await screen.findByRole('checkbox', { name: PRIVATE_LABEL });
    expect(screen.queryByRole('combobox', { name: 'Printing' })).toBeNull();
    expect(screen.queryByText(HELP)).toBeNull();
  });

  it('offers Inherit (naming the source and what it gives), Allowed and Not allowed, with the help text', async () => {
    const node = { ...NODE, printing_from: { node_id: 'f1', title: 'Engineering' }, can_print: false };
    render(<PermissionsDialog target={{ kind: 'node', node }} onClose={() => {}} />);
    const box = await screen.findByRole('combobox', { name: 'Printing' });
    expect(box).toHaveProperty('value', 'Inherit (Not allowed, from Engineering)');
    fireEvent.focus(box);
    expect(screen.getByRole('button', { name: 'Allowed' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Not allowed' })).toBeTruthy();
    expect(screen.getByText(HELP)).toBeTruthy();
  });

  it('names the library when that is where the setting comes from', async () => {
    render(<PermissionsDialog target={{ kind: 'node', node: NODE }} onClose={() => {}} />);
    expect(await screen.findByRole('combobox', { name: 'Printing' }))
      .toHaveProperty('value', 'Inherit (Allowed, from Library)');
  });

  it('saves the choice at once: allowed, not allowed, and back to inheriting', async () => {
    vi.mocked(setNodePrinting).mockResolvedValue({ ...NODE, allow_printing: false, can_print: false, printing_from: null });
    render(<PermissionsDialog target={{ kind: 'node', node: NODE }} onClose={() => {}} />);
    await screen.findByRole('combobox', { name: 'Printing' });

    pick('Printing', 'Not allowed');
    await waitFor(() => expect(setNodePrinting).toHaveBeenLastCalledWith('n1', false));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Printing' })).toHaveProperty('value', 'Not allowed'));

    vi.mocked(setNodePrinting).mockResolvedValue({ ...NODE, allow_printing: true, printing_from: null });
    pick('Printing', 'Allowed');
    await waitFor(() => expect(setNodePrinting).toHaveBeenLastCalledWith('n1', true));

    vi.mocked(setNodePrinting).mockResolvedValue(NODE);
    pick('Printing', 'Inherit');
    await waitFor(() => expect(setNodePrinting).toHaveBeenLastCalledWith('n1', null));
  });

  it('shows a refusal in the dialog\'s error spot', async () => {
    vi.mocked(setNodePrinting).mockRejectedValue(new ApiError(403, 'forbidden', undefined, 'You can\'t manage this.'));
    render(<PermissionsDialog target={{ kind: 'node', node: NODE }} onClose={() => {}} />);
    await screen.findByRole('combobox', { name: 'Printing' });
    pick('Printing', 'Allowed');
    expect(await screen.findByText('You can\'t manage this.')).toBeTruthy();
  });

  it('is not part of a library\'s permissions', async () => {
    vi.mocked(getSpaceGrants).mockResolvedValue([]);
    render(<PermissionsEditor target={{ kind: 'space', space: makeSpace({ my_level: 'manage' }) }} />);
    await screen.findByText('No one has access yet');
    expect(screen.queryByRole('combobox', { name: 'Printing' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: PRIVATE_LABEL })).toBeNull();
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
