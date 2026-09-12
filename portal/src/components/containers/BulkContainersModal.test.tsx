// @vitest-environment jsdom
/**
 * BulkContainersModal — the "+ Add in bulk" flow. Covers: the live
 * naming preview, the per-tag stepper's bounds (0 and the running
 * count), the Count field's clear/retype/blur behavior (clamp applies on
 * blur and at submit, never per keystroke), Escape scoped to an open
 * ComboBox's own list rather than the whole dialog, the exact
 * `POST /containers/bulk` payload (including a non-null Initiative/Site),
 * the `name_collision` 422's message, the footer's Type-required gating,
 * and a successful create closing the modal and handing the created rows
 * to `onCreated`.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

const NAMED_SITES: SiteItem[] = [
  { id: 's1', name: 'NAP11', archived_at: null, created_at: '2026-01-01T00:00:00Z' } as unknown as SiteItem,
];
const NAMED_INITIATIVES: InitiativeItem[] = [
  { id: 'i1', name: 'Hall Migration', client_name: 'Acme', created_at: '2026-01-01T00:00:00Z' } as unknown as InitiativeItem,
];

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

/** Clear → retype → tab away (blurring the field) — the real interaction
 *  a user replacing an existing Count performs, and the one that commits
 *  the value (Count's clamp-tags side effect fires on blur, not on every
 *  keystroke — see BulkContainersModal.tsx's `applyCountClamp`). */
async function setCount(user: ReturnType<typeof userEvent.setup>, value: string) {
  const input = numberInput('Count');
  await user.clear(input);
  await user.type(input, value);
  await user.tab();
}

it('the Preview line updates live as naming fields change, with the zero-pad derived from the batch', async () => {
  const user = userEvent.setup();
  mount();
  // count 1, start 1 → last number 1 → 2 digits (one leading zero)
  expect(document.getElementById('bulk-preview')!.textContent).toBe('01');

  await user.type(numberInput('Prefix'), 'PLT-');
  await setCount(user, '5');
  expect(document.getElementById('bulk-preview')!.textContent).toBe('PLT-01, PLT-02, PLT-03 … PLT-05');

  // the automatic value is a MINIMUM: wider is allowed, narrower is not
  expect((screen.getByRole('tab', { name: '2 digits' }) as HTMLButtonElement).disabled).toBe(false);
  await user.click(screen.getByRole('tab', { name: '4 digits' }));
  expect(document.getElementById('bulk-preview')!.textContent).toBe('PLT-0001, PLT-0002, PLT-0003 … PLT-0005');

  // a bigger batch raises the minimum above a narrower override
  await setCount(user, '120');
  expect((screen.getByRole('tab', { name: '2 digits' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('tab', { name: '3 digits' }) as HTMLButtonElement).disabled).toBe(true);
  expect(document.getElementById('bulk-preview')!.textContent).toBe('PLT-0001, PLT-0002, PLT-0003 … PLT-0120');
});

it('warns and refuses when the batch would run past four digits', async () => {
  const user = userEvent.setup();
  mount();
  await user.clear(numberInput('Start number'));
  await user.type(numberInput('Start number'), '9998');
  await setCount(user, '5');
  expect(screen.getByText(/can't go past 9999/)).not.toBeNull();
  expect((screen.getByRole('button', { name: /Create 5 containers/ }) as HTMLButtonElement).disabled).toBe(true);
});

it('Count can be fully cleared and retyped without losing digits or snapping back', async () => {
  const user = userEvent.setup();
  mount();
  const input = numberInput('Count');
  await user.clear(input);
  expect(input.value).toBe('');   // not forced back to "1" while empty
  await user.type(input, '15');
  expect(input.value).toBe('15');
  await user.tab();
  expect(input.value).toBe('15'); // normalized (unchanged, already valid) on blur
  expect(screen.getByRole('button', { name: 'Create 15 containers' })).toBeTruthy();
});

it('a tag stepper disables − at 0 and disables every + once the total reaches Count', async () => {
  const user = userEvent.setup();
  mount();
  await setCount(user, '2');

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

it('the footer is disabled until a Type is chosen', async () => {
  const user = userEvent.setup();
  mount();
  const footer = () => screen.getByRole('button', { name: /Create 1 container/ }) as HTMLButtonElement;
  expect(footer().disabled).toBe(true);

  await user.click(screen.getByPlaceholderText('Type to search types…'));
  await user.click(await screen.findByText('Pallet'));
  expect(footer().disabled).toBe(false);
});

it('submits the exact bulk-create payload', async () => {
  const user = userEvent.setup();
  api.bulkCreateContainers.mockResolvedValue({ created: [container()] });
  mount();

  await setCount(user, '3');
  await user.type(numberInput('Prefix'), 'PLT-');
  await user.click(screen.getByPlaceholderText('Type to search types…'));
  await user.click(await screen.findByText('Pallet'));
  await user.click(screen.getByRole('button', { name: 'More Priority' }));

  await user.click(screen.getByRole('button', { name: 'Create 3 containers' }));

  await waitFor(() => expect(api.bulkCreateContainers).toHaveBeenCalled());
  expect(api.bulkCreateContainers).toHaveBeenCalledWith({
    count: 3,
    container_type: 'pallet',
    naming: { prefix: 'PLT-', start: 1, pad: 2, suffix: '' },
    initiative_id: null,
    site_id: null,
    status: null,
    tags: { priority: 1, vendor: 0, accessories: 0, warehouse: 0, ewaste: 0 },
  });
});

it('sends the chosen Initiative and Site ids in their own (not swapped) payload fields', async () => {
  const user = userEvent.setup();
  api.bulkCreateContainers.mockResolvedValue({ created: [container()] });
  mount({ sites: NAMED_SITES, initiatives: NAMED_INITIATIVES });

  await user.click(screen.getByPlaceholderText('Type to search types…'));
  await user.click(await screen.findByText('Pallet'));
  await user.click(screen.getByPlaceholderText('Type to search initiatives…'));
  await user.click(await screen.findByText('Hall Migration'));
  await user.click(screen.getByPlaceholderText('Type to search sites…'));
  await user.click(await screen.findByText('NAP11'));

  await user.click(screen.getByRole('button', { name: /Create 1 container/ }));

  await waitFor(() => expect(api.bulkCreateContainers).toHaveBeenCalled());
  expect(api.bulkCreateContainers.mock.calls[0][0]).toMatchObject({
    initiative_id: 'i1',
    site_id: 's1',
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

it('Escape inside an open ComboBox list closes only the list, not the modal', async () => {
  const user = userEvent.setup();
  const { onClose } = mount();

  await user.click(screen.getByPlaceholderText('Type to search types…'));
  expect(await screen.findByText('Pallet')).toBeTruthy();

  await user.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByText('Pallet')).toBeNull();   // the list itself did close

  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalled();
});

it('lowering Count below the tag total clamps from the last tag backwards and shows a notice', async () => {
  const user = userEvent.setup();
  mount();
  await setCount(user, '5');
  const plus = (label: string) => screen.getByRole('button', { name: `More ${label}` });
  await user.click(plus('Priority'));
  await user.click(plus('Vendor'));
  await user.click(plus('Vendor'));
  // total is 3 (1 priority, 2 vendor); dropping Count to 2 must trim
  // vendor (the later tag) rather than priority.
  await setCount(user, '2');

  expect(screen.getByText(/trimmed/i)).toBeTruthy();
  const vendorCount = within(screen.getByRole('button', { name: 'More Vendor' }).parentElement!)
    .getByText('1');
  expect(vendorCount).toBeTruthy();
});

it('a mid-retype dip in Count does not trim tags before the final value settles on blur', async () => {
  const user = userEvent.setup();
  mount();
  await setCount(user, '5');
  await user.click(screen.getByRole('button', { name: 'More Vendor' }));
  await user.click(screen.getByRole('button', { name: 'More Vendor' }));

  // Replacing "5" with "25" necessarily passes through "2" for one
  // keystroke — that transient dip must not trim the 2 Vendor tags
  // already set, since the final, settled value (25) fits them fine.
  const input = numberInput('Count');
  await user.clear(input);
  await user.type(input, '25');
  await user.tab();

  expect(screen.queryByText(/trimmed/i)).toBeNull();
  const vendorCount = within(screen.getByRole('button', { name: 'More Vendor' }).parentElement!)
    .getByText('2');
  expect(vendorCount).toBeTruthy();
});
