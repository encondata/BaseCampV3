// @vitest-environment jsdom
/**
 * BulkContainersModal — the "+ Add in bulk" flow. Covers: the live
 * naming preview, the per-tag stepper's bounds (0 and the running
 * count), the exact `POST /containers/bulk` payload, the `name_collision`
 * 422's message, and a successful create closing the modal and handing
 * the created rows to `onCreated`.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ContainerItem, InitiativeItem, SiteItem, StatusValue } from '../../lib/api';

const api = vi.hoisted(() => ({ bulkCreateContainers: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { default: BulkContainersModal } = await import('./BulkContainersModal');
const { ApiError } = await import('../../lib/api');

const TYPES: StatusValue[] = [
  { key: 'pallet', label: 'Pallet', color: '#1890ff', is_active: true } as unknown as StatusValue,
];
const SITES: SiteItem[] = [];
const INITIATIVES: InitiativeItem[] = [];

function container(over: Partial<ContainerItem> = {}): ContainerItem {
  return {
    id: 'c1', name: 'PLT-001', rfid_tag: null,
    container_type: 'pallet', type_label: 'Pallet', type_color: '#1890ff',
    status: 'available', status_label: 'Available', status_color: '#22aa55',
    site_id: null, site_name: null, location_detail: '', asset_count: 0,
    last_audit_at: null, last_validated_at: null,
    archived_at: null, created_at: '2026-09-12T00:00:00Z',
    initiative_id: null, initiative_name: null,
    ...over,
  };
}

beforeEach(() => {
  api.bulkCreateContainers.mockReset();
});
afterEach(cleanup);

const mount = (over: Partial<Parameters<typeof BulkContainersModal>[0]> = {}) => {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(<BulkContainersModal types={TYPES} sites={SITES} initiatives={INITIATIVES}
                               onClose={onClose} onCreated={onCreated} {...over} />);
  return { onClose, onCreated };
};

const numberInput = (label: string) =>
  screen.getByLabelText(label) as HTMLInputElement;

it('the Preview line updates live as naming fields change', async () => {
  const user = userEvent.setup();
  mount();
  expect(screen.getByText(/Preview:/).textContent).toBe('Preview: 001');

  await user.type(numberInput('Prefix'), 'PLT-');
  // A single change event with the final value — the same one-shot update
  // a spinner click or pasted value produces — rather than clearing then
  // retyping digit-by-digit, which would otherwise walk Count through a
  // transient smaller value and trip the live tag-clamp below.
  fireEvent.change(numberInput('Count'), { target: { value: '5' } });
  expect(screen.getByText(/Preview:/).textContent).toBe('Preview: PLT-001, PLT-002, PLT-003 … PLT-005');

  await user.click(screen.getByRole('tab', { name: '0' }));
  expect(screen.getByText(/Preview:/).textContent).toBe('Preview: PLT-1, PLT-2, PLT-3 … PLT-5');
});

it('a tag stepper disables − at 0 and disables every + once the total reaches Count', async () => {
  const user = userEvent.setup();
  mount();
  fireEvent.change(numberInput('Count'), { target: { value: '2' } });

  const priorityMinus = screen.getByRole('button', { name: 'Fewer Priority' }) as HTMLButtonElement;
  const priorityPlus = screen.getByRole('button', { name: 'More Priority' }) as HTMLButtonElement;
  const vendorPlus = screen.getByRole('button', { name: 'More Vendor' }) as HTMLButtonElement;
  expect(priorityMinus.disabled).toBe(true);

  await user.click(priorityPlus);
  await user.click(priorityPlus);
  // total (2) now equals count (2): every + is disabled, including a
  // different tag's own +.
  expect(priorityPlus.disabled).toBe(true);
  expect(vendorPlus.disabled).toBe(true);
  expect(priorityMinus.disabled).toBe(false);

  await user.click(priorityMinus);
  await user.click(priorityMinus);
  expect(priorityMinus.disabled).toBe(true);
  expect(priorityPlus.disabled).toBe(false);
});

it('submits the exact bulk-create payload', async () => {
  const user = userEvent.setup();
  api.bulkCreateContainers.mockResolvedValue({ created: [container()] });
  mount();

  fireEvent.change(numberInput('Count'), { target: { value: '3' } });
  await user.type(numberInput('Prefix'), 'PLT-');
  await user.click(screen.getByPlaceholderText('Type to search types…'));
  await user.click(await screen.findByText('Pallet'));
  await user.click(screen.getByRole('button', { name: 'More Priority' }));

  await user.click(screen.getByRole('button', { name: 'Create 3 containers' }));

  await waitFor(() => expect(api.bulkCreateContainers).toHaveBeenCalled());
  expect(api.bulkCreateContainers).toHaveBeenCalledWith({
    count: 3,
    container_type: 'pallet',
    naming: { prefix: 'PLT-', start: 1, pad: 3, suffix: '' },
    initiative_id: null,
    site_id: null,
    status: null,
    tags: { priority: 1, vendor: 0, accessories: 0, warehouse: 0, ewaste: 0 },
  });
});

it('shows the colliding names under the naming fields on a name_collision 422', async () => {
  const user = userEvent.setup();
  api.bulkCreateContainers.mockRejectedValue(
    new ApiError(422, 'name_collision', { names: ['PLT-001', 'PLT-002'] }));
  mount();

  await user.type(numberInput('Prefix'), 'PLT-');
  await user.click(screen.getByPlaceholderText('Type to search types…'));
  await user.click(await screen.findByText('Pallet'));
  await user.click(screen.getByRole('button', { name: /Create 1 container/ }));

  await waitFor(() => expect(screen.getByText(/Already exists:/)).toBeTruthy());
  expect(screen.getByText('Already exists: PLT-001, PLT-002')).toBeTruthy();
});

it('on success calls onCreated with the created rows and closes', async () => {
  const user = userEvent.setup();
  const created = [container({ id: 'c1' }), container({ id: 'c2', name: 'PLT-002' })];
  api.bulkCreateContainers.mockResolvedValue({ created });
  const { onClose, onCreated } = mount();

  await user.type(numberInput('Prefix'), 'PLT-');
  await user.click(screen.getByPlaceholderText('Type to search types…'));
  await user.click(await screen.findByText('Pallet'));
  await user.click(screen.getByRole('button', { name: /Create 1 container/ }));

  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
  expect(onClose).toHaveBeenCalled();
});

it('Escape closes the modal', async () => {
  const user = userEvent.setup();
  const { onClose } = mount();
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalled();
});

it('lowering Count below the tag total clamps from the last tag backwards and shows a notice', async () => {
  const user = userEvent.setup();
  mount();
  fireEvent.change(numberInput('Count'), { target: { value: '5' } });
  const plus = (label: string) => screen.getByRole('button', { name: `More ${label}` });
  await user.click(plus('Priority'));
  await user.click(plus('Vendor'));
  await user.click(plus('Vendor'));
  // total is 3 (1 priority, 2 vendor); dropping Count to 2 must trim
  // vendor (the later tag) rather than priority.
  fireEvent.change(numberInput('Count'), { target: { value: '2' } });

  expect(screen.getByText(/trimmed/i)).toBeTruthy();
  const vendorCount = within(screen.getByRole('button', { name: 'More Vendor' }).parentElement!)
    .getByText('1');
  expect(vendorCount).toBeTruthy();
});
