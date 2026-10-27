// @vitest-environment jsdom
/**
 * The packet editor: name, description, the ordered documents (up/down or
 * drag), enforce order and the due offset, then Save (create or a patch of
 * what changed), Copy and Archive. Each control follows the API's action:
 * save = add (new) or change, Copy = add, Archive = delete.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { LearningDocumentListItem, LearningPacket } from '../../lib/learning';

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
  getLearningPacket: vi.fn(),
  createLearningPacket: vi.fn(),
  patchLearningPacket: vi.fn(),
  copyLearningPacket: vi.fn(),
  archiveLearningPacket: vi.fn(),
  listLearningDocuments: vi.fn(),
}));
vi.mock('../../lib/learning', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/learning')>()),
  ...api,
}));

const { default: PacketEditor } = await import('./PacketEditor');

const item = (id: string, title: string, v: number | null = 1, archived = false) =>
  ({ document_id: id, title, current_version_no: v, archived });

const PACKET: LearningPacket = {
  id: 'p1', name: 'Standard onboarding', description: 'For every new worker', enforce_order: false,
  due_offset_days: null, icon: null, color: null,
  items: [item('d1', 'Dress code', 4), item('d2', 'Confidentiality', 2), item('d3', 'Work expectations', 1)],
  archived_at: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
};

const DOCS = [
  { id: 'd1', title: 'Dress code', current_version_no: 4 },
  { id: 'd2', title: 'Confidentiality', current_version_no: 2 },
  { id: 'd4', title: 'Forklift safety', current_version_no: null },
] as LearningDocumentListItem[];

const onClose = vi.fn();
const onSaved = vi.fn();
const onChanged = vi.fn();

function renderEditor(packetId: string | null = 'p1') {
  return render(<PacketEditor packetId={packetId} onClose={onClose} onSaved={onSaved} onChanged={onChanged} />);
}

const titles = (dialog: HTMLElement) =>
  within(dialog).getAllByRole('listitem').map((li) => li.querySelector('.lrn-item-title')?.textContent);

beforeEach(() => {
  auth.perms = { view: true, add: true, change: true, delete: true };
  api.getLearningPacket.mockReset().mockResolvedValue(PACKET);
  api.listLearningDocuments.mockReset().mockResolvedValue(DOCS);
  api.createLearningPacket.mockReset().mockImplementation(async (b: object) => ({ ...PACKET, id: 'new', ...b }));
  api.patchLearningPacket.mockReset().mockImplementation(async (_id: string, b: object) => ({ ...PACKET, ...b }));
  api.copyLearningPacket.mockReset().mockResolvedValue({ ...PACKET, id: 'p2', name: 'Standard onboarding (copy)' });
  api.archiveLearningPacket.mockReset().mockResolvedValue(undefined);
  onClose.mockReset();
  onSaved.mockReset();
  onChanged.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows the packet with its documents in order', async () => {
  renderEditor();
  const dialog = await screen.findByRole('dialog', { name: /edit packet/i });
  expect(await within(dialog).findByDisplayValue('Standard onboarding')).toBeTruthy();
  expect(within(dialog).getByDisplayValue('For every new worker')).toBeTruthy();
  expect(titles(dialog)).toEqual(['Dress code', 'Confidentiality', 'Work expectations']);
  expect(within(dialog).getByText('v4')).toBeTruthy();
  // nothing changed yet, nothing to save
  expect(within(dialog).getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(true);
});

it('moves documents up and down and saves the new order as document ids', async () => {
  const user = userEvent.setup();
  renderEditor();
  const dialog = await screen.findByRole('dialog', { name: /edit packet/i });
  await within(dialog).findByDisplayValue('Standard onboarding');
  expect(within(dialog).getAllByRole('button', { name: /^Move up/ })[0].hasAttribute('disabled')).toBe(true);
  await user.click(within(dialog).getByRole('button', { name: 'Move up Work expectations' }));
  await user.click(within(dialog).getByRole('button', { name: 'Move down Dress code' }));
  expect(titles(dialog)).toEqual(['Work expectations', 'Dress code', 'Confidentiality']);

  await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(api.patchLearningPacket).toHaveBeenCalledWith('p1', { items: ['d3', 'd1', 'd2'] }));
  expect(onSaved).toHaveBeenCalled();
});

it('drags a document to a new place', async () => {
  const user = userEvent.setup();
  renderEditor();
  const dialog = await screen.findByRole('dialog', { name: /edit packet/i });
  await within(dialog).findByDisplayValue('Standard onboarding');
  const rows = within(dialog).getAllByRole('listitem');
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
  fireEvent.dragStart(rows[2], { dataTransfer });
  fireEvent.dragOver(rows[0], { dataTransfer, clientY: 0 });   // jsdom boxes are empty: lands after
  fireEvent.drop(rows[0], { dataTransfer });
  expect(titles(dialog)).toEqual(['Dress code', 'Work expectations', 'Confidentiality']);
  await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(api.patchLearningPacket).toHaveBeenCalledWith('p1', { items: ['d1', 'd3', 'd2'] }));
});

it('adds a document that is not in the packet and removes one', async () => {
  const user = userEvent.setup();
  renderEditor();
  const dialog = await screen.findByRole('dialog', { name: /edit packet/i });
  await within(dialog).findByDisplayValue('Standard onboarding');
  await user.click(within(dialog).getByRole('button', { name: 'Remove Confidentiality' }));
  fireEvent.focus(within(dialog).getByLabelText('Add a document'));
  // documents already in the packet are not offered
  expect(screen.queryByRole('button', { name: /^Dress code/ })).toBeNull();
  fireEvent.mouseDown(screen.getByText('Forklift safety'));
  expect(titles(dialog)).toEqual(['Dress code', 'Work expectations', 'Forklift safety']);
  await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(api.patchLearningPacket).toHaveBeenCalledWith('p1', { items: ['d1', 'd3', 'd4'] }));
});

it('sends only the fields that changed: name, enforce order and a due offset', async () => {
  const user = userEvent.setup();
  renderEditor();
  const dialog = await screen.findByRole('dialog', { name: /edit packet/i });
  const name = await within(dialog).findByDisplayValue('Standard onboarding');
  fireEvent.change(name, { target: { value: 'Standard onboarding 2' } });
  await user.click(within(dialog).getByRole('checkbox', { name: /finish the documents in order/i }));
  await user.click(within(dialog).getByRole('button', { name: 'Days before start' }));
  // the number starts empty and a packet with an empty offset can't be saved
  expect(within(dialog).getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(within(dialog).getByLabelText('Days before the initiative starts'), { target: { value: '3' } });
  await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(api.patchLearningPacket).toHaveBeenCalledWith('p1', {
    name: 'Standard onboarding 2', enforce_order: true, due_offset_days: 3,
  }));
});

it('going back to the initiative schedule clears the offset', async () => {
  api.getLearningPacket.mockResolvedValue({ ...PACKET, due_offset_days: 5 });
  const user = userEvent.setup();
  renderEditor();
  const dialog = await screen.findByRole('dialog', { name: /edit packet/i });
  await within(dialog).findByDisplayValue('Standard onboarding');
  expect((within(dialog).getByLabelText('Days before the initiative starts') as HTMLInputElement).value).toBe('5');
  await user.click(within(dialog).getByRole('button', { name: 'Initiative schedule' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(api.patchLearningPacket).toHaveBeenCalledWith('p1', { due_offset_days: null }));
});

it('creates a new packet with its documents, in order', async () => {
  const user = userEvent.setup();
  renderEditor(null);
  const dialog = await screen.findByRole('dialog', { name: /new packet/i });
  expect(api.getLearningPacket).not.toHaveBeenCalled();
  const create = within(dialog).getByRole('button', { name: 'Create packet' });
  expect(create.hasAttribute('disabled')).toBe(true);
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Acme site rules' } });
  await waitFor(() => expect(api.listLearningDocuments).toHaveBeenCalled());
  for (const title of ['Confidentiality', 'Dress code']) {
    fireEvent.focus(within(dialog).getByLabelText('Add a document'));
    fireEvent.mouseDown(await screen.findByText(title));
  }
  await user.click(create);
  await waitFor(() => expect(api.createLearningPacket).toHaveBeenCalledWith({
    name: 'Acme site rules', description: null, enforce_order: false, due_offset_days: null,
    items: ['d2', 'd1'],
  }));
  expect(onSaved).toHaveBeenCalled();
});

it('Copy makes a copy and reports it', async () => {
  const user = userEvent.setup();
  renderEditor();
  const dialog = await screen.findByRole('dialog', { name: /edit packet/i });
  await within(dialog).findByDisplayValue('Standard onboarding');
  await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
  await waitFor(() => expect(api.copyLearningPacket).toHaveBeenCalledWith('p1'));
  expect(onChanged).toHaveBeenCalledWith('Copied as Standard onboarding (copy)');
});

it('Archive asks first, then archives', async () => {
  const user = userEvent.setup();
  renderEditor();
  const dialog = await screen.findByRole('dialog', { name: /edit packet/i });
  await within(dialog).findByDisplayValue('Standard onboarding');
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
  expect(api.archiveLearningPacket).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
  await waitFor(() => expect(api.archiveLearningPacket).toHaveBeenCalledWith('p1'));
  expect(onChanged).toHaveBeenCalledWith('Archived Standard onboarding');
});

it('a save failure stays in the editor with the server wording', async () => {
  api.patchLearningPacket.mockRejectedValueOnce(new ApiError(
    422, 'bad_document', { code: 'bad_document', message: 'x' }));
  const user = userEvent.setup();
  renderEditor();
  const dialog = await screen.findByRole('dialog', { name: /edit packet/i });
  await within(dialog).findByDisplayValue('Standard onboarding');
  await user.click(within(dialog).getByRole('button', { name: 'Move down Dress code' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  expect(await within(dialog).findByText(/doesn.t exist or is archived/i)).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
});

it('without change, add and delete the editor is read-only', async () => {
  auth.perms = { view: true };
  renderEditor();
  const dialog = await screen.findByRole('dialog', { name: /packet/i });
  await within(dialog).findByDisplayValue('Standard onboarding');
  expect(within(dialog).getByLabelText('Name').hasAttribute('disabled')).toBe(true);
  for (const name of ['Save changes', 'Copy', 'Archive']) {
    expect(within(dialog).queryByRole('button', { name })).toBeNull();
  }
  expect(within(dialog).queryByRole('button', { name: /^Move up/ })).toBeNull();
  expect(within(dialog).queryByLabelText('Add a document')).toBeNull();
});

it('gates Copy on add and Archive on delete', async () => {
  auth.perms = { view: true, change: true, delete: true };
  const first = renderEditor();
  let dialog = await screen.findByRole('dialog', { name: /edit packet/i });
  await within(dialog).findByDisplayValue('Standard onboarding');
  expect(within(dialog).queryByRole('button', { name: 'Copy' })).toBeNull();
  expect(within(dialog).getByRole('button', { name: 'Archive' })).toBeTruthy();
  first.unmount();

  auth.perms = { view: true, change: true, add: true };
  renderEditor();
  dialog = await screen.findByRole('dialog', { name: /edit packet/i });
  await within(dialog).findByDisplayValue('Standard onboarding');
  expect(within(dialog).getByRole('button', { name: 'Copy' })).toBeTruthy();
  expect(within(dialog).queryByRole('button', { name: 'Archive' })).toBeNull();
});
