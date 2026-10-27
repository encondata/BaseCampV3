// @vitest-environment jsdom
/**
 * The rule editor: a name, a packet, and conditions built from a field
 * picker with value pickers (initiative, client, site, partner and person
 * through ComboBoxes; countries from the sites list; worker roles from the
 * work types). It sends `conditions` as [{field, values}] with ids
 * lowercased and countries uppercased.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { LearningRule, PacketListItem } from '../../lib/learning';

const api = vi.hoisted(() => ({
  createLearningRule: vi.fn(),
  patchLearningRule: vi.fn(),
  listLearningPackets: vi.fn(),
}));
vi.mock('../../lib/learning', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/learning')>()),
  ...api,
}));

const CLIENT_ID = 'AAAAAAAA-0000-4000-8000-00000000000A';
const lookups = {
  options: vi.fn(),
  status: vi.fn(),
  load: vi.fn(),
  retry: vi.fn(),
  label: vi.fn(),
};
const LISTS: Record<string, { value: string; label: string; sub?: string | null }[]> = {
  client: [{ value: CLIENT_ID.toLowerCase(), label: 'Acme Corp' }, { value: 'c2', label: 'Globex' }],
  site_country: [{ value: 'SINGAPORE', label: 'Singapore' }, { value: 'MALAYSIA', label: 'Malaysia' }],
  worker_role: [{ value: 'forklift', label: 'Forklift operator' }],
  partner: [{ value: 'pa1', label: 'Fast Freight' }],
  person: [{ value: 'pe1', label: 'Ana Lim' }],
  initiative: [{ value: 'i1', label: 'Acme DFW move' }],
  site: [{ value: 's1', label: 'DFW data center' }],
};

const { default: RuleEditorModal } = await import('./RuleEditorModal');

const PACKETS = [
  { id: 'pk1', name: 'Standard onboarding', archived_at: null },
  { id: 'pk2', name: 'Acme site rules', archived_at: null },
] as PacketListItem[];

const onClose = vi.fn();
const onSaved = vi.fn();

function renderModal(rule: LearningRule | null = null) {
  return render(<RuleEditorModal rule={rule} lookups={lookups} onClose={onClose} onSaved={onSaved} />);
}

async function pick(dialog: HTMLElement, label: string, text: string) {
  fireEvent.focus(within(dialog).getByLabelText(label));
  fireEvent.mouseDown(await screen.findByText(text));
}

beforeEach(() => {
  api.listLearningPackets.mockReset().mockResolvedValue(PACKETS);
  api.createLearningRule.mockReset().mockImplementation(async (b: object) => ({ id: 'r9', ...b }));
  api.patchLearningRule.mockReset().mockImplementation(async (id: string, b: object) => ({ id, ...b }));
  lookups.options.mockReset().mockImplementation((kind: string) => LISTS[kind] ?? []);
  lookups.status.mockReset().mockReturnValue('ready');
  lookups.load.mockReset();
  lookups.retry.mockReset();
  lookups.label.mockReset().mockImplementation((_k: string, v: string) => v);
  onClose.mockReset();
  onSaved.mockReset();
});
afterEach(cleanup);

it('builds conditions from the field pickers and creates the rule', async () => {
  const user = userEvent.setup();
  renderModal();
  const dialog = await screen.findByRole('dialog', { name: /new assignment rule/i });
  const save = within(dialog).getByRole('button', { name: 'Create rule' });
  expect(save.hasAttribute('disabled')).toBe(true);

  fireEvent.change(within(dialog).getByLabelText('Rule name'), { target: { value: 'Acme in Singapore' } });
  await waitFor(() => expect(api.listLearningPackets).toHaveBeenCalled());
  await pick(dialog, 'Packet', 'Acme site rules');
  expect(save.hasAttribute('disabled')).toBe(true);      // the first condition has no value yet

  // condition 1: Client is Acme Corp
  fireEvent.change(within(dialog).getByLabelText('Condition 1 field'), { target: { value: 'client' } });
  expect(lookups.load).toHaveBeenCalledWith('client');
  await pick(dialog, 'Condition 1 values', 'Acme Corp');
  // condition 2: Site country is Singapore and Malaysia
  await user.click(within(dialog).getByRole('button', { name: 'Add condition' }));
  fireEvent.change(within(dialog).getByLabelText('Condition 2 field'), { target: { value: 'site_country' } });
  await pick(dialog, 'Condition 2 values', 'Singapore');
  await pick(dialog, 'Condition 2 values', 'Malaysia');
  // condition 3: Worker role is Forklift operator
  await user.click(within(dialog).getByRole('button', { name: 'Add condition' }));
  fireEvent.change(within(dialog).getByLabelText('Condition 3 field'), { target: { value: 'worker_role' } });
  await pick(dialog, 'Condition 3 values', 'Forklift operator');

  await user.click(save);
  await waitFor(() => expect(api.createLearningRule).toHaveBeenCalledWith({
    name: 'Acme in Singapore', packet_id: 'pk2', enabled: true,
    conditions: [
      { field: 'client', values: [CLIENT_ID.toLowerCase()] },
      { field: 'site_country', values: ['SINGAPORE', 'MALAYSIA'] },
      { field: 'worker_role', values: ['forklift'] },
    ],
  }));
  expect(onSaved).toHaveBeenCalled();
});

it('normalizes values on the way out: ids lowercase, countries upper case', async () => {
  const user = userEvent.setup();
  lookups.options.mockImplementation((kind: string) => (kind === 'client'
    ? [{ value: CLIENT_ID, label: 'Acme Corp' }]
    : kind === 'site_country' ? [{ value: 'singapore', label: 'Singapore' }] : []));
  renderModal();
  const dialog = await screen.findByRole('dialog', { name: /new assignment rule/i });
  fireEvent.change(within(dialog).getByLabelText('Rule name'), { target: { value: 'Mixed case' } });
  await waitFor(() => expect(api.listLearningPackets).toHaveBeenCalled());
  await pick(dialog, 'Packet', 'Standard onboarding');
  fireEvent.change(within(dialog).getByLabelText('Condition 1 field'), { target: { value: 'client' } });
  await pick(dialog, 'Condition 1 values', 'Acme Corp');
  await user.click(within(dialog).getByRole('button', { name: 'Add condition' }));
  fireEvent.change(within(dialog).getByLabelText('Condition 2 field'), { target: { value: 'site_country' } });
  await pick(dialog, 'Condition 2 values', 'Singapore');
  await user.click(within(dialog).getByRole('button', { name: 'Create rule' }));
  await waitFor(() => expect(api.createLearningRule).toHaveBeenCalled());
  expect(api.createLearningRule.mock.calls[0][0].conditions).toEqual([
    { field: 'client', values: [CLIENT_ID.toLowerCase()] },
    { field: 'site_country', values: ['SINGAPORE'] },
  ]);
});

it('Everyone takes no values and needs no picker', async () => {
  const user = userEvent.setup();
  renderModal();
  const dialog = await screen.findByRole('dialog', { name: /new assignment rule/i });
  fireEvent.change(within(dialog).getByLabelText('Rule name'), { target: { value: 'All workers' } });
  await waitFor(() => expect(api.listLearningPackets).toHaveBeenCalled());
  await pick(dialog, 'Packet', 'Standard onboarding');
  fireEvent.change(within(dialog).getByLabelText('Condition 1 field'), { target: { value: 'everyone' } });
  expect(within(dialog).queryByLabelText('Condition 1 values')).toBeNull();
  expect(within(dialog).getByText(/everyone who is added to an initiative/i)).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Create rule' }));
  await waitFor(() => expect(api.createLearningRule).toHaveBeenCalledWith({
    name: 'All workers', packet_id: 'pk1', enabled: true, conditions: [{ field: 'everyone', values: [] }],
  }));
});

it('a field already used is not offered for another condition', async () => {
  const user = userEvent.setup();
  renderModal();
  const dialog = await screen.findByRole('dialog', { name: /new assignment rule/i });
  fireEvent.change(within(dialog).getByLabelText('Condition 1 field'), { target: { value: 'client' } });
  await user.click(within(dialog).getByRole('button', { name: 'Add condition' }));
  const second = within(dialog).getByLabelText('Condition 2 field') as HTMLSelectElement;
  expect(Array.from(second.options).map((o) => o.text)).not.toContain('Client');
});

it('offers the countries the lookups return and says when a list could not load', async () => {
  lookups.status.mockImplementation((kind: string) => (kind === 'person' ? 'failed' : 'ready'));
  const user = userEvent.setup();
  renderModal();
  const dialog = await screen.findByRole('dialog', { name: /new assignment rule/i });
  fireEvent.change(within(dialog).getByLabelText('Condition 1 field'), { target: { value: 'person' } });
  expect(within(dialog).getByText(/couldn.t load the people/i)).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
  expect(lookups.retry).toHaveBeenCalledWith('person');
});

it('editing prefills the rule and patches it', async () => {
  const rule: LearningRule = {
    id: 'r1', name: 'Acme', packet_id: 'pk2', packet_name: 'Acme site rules', packet_archived: false,
    conditions: [{ field: 'client', values: ['c2'] }], position: 2, enabled: false,
    created_at: '', updated_at: '',
  };
  const user = userEvent.setup();
  renderModal(rule);
  const dialog = await screen.findByRole('dialog', { name: /edit assignment rule/i });
  expect((within(dialog).getByLabelText('Rule name') as HTMLInputElement).value).toBe('Acme');
  expect((within(dialog).getByLabelText('Condition 1 field') as HTMLSelectElement).value).toBe('client');
  expect(within(dialog).getByText('Globex')).toBeTruthy();
  expect((within(dialog).getByRole('checkbox', { name: 'Rule is on' }) as HTMLInputElement).checked).toBe(false);
  await user.click(within(dialog).getByRole('checkbox', { name: 'Rule is on' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));
  await waitFor(() => expect(api.patchLearningRule).toHaveBeenCalledWith('r1', {
    name: 'Acme', packet_id: 'pk2', conditions: [{ field: 'client', values: ['c2'] }], enabled: true,
  }));
});

it('keeps an archived packet visible on an existing rule', async () => {
  const rule: LearningRule = {
    id: 'r1', name: 'Old', packet_id: 'pkX', packet_name: 'Retired packet', packet_archived: true,
    conditions: [{ field: 'everyone', values: [] }], position: 1, enabled: true,
    created_at: '', updated_at: '',
  };
  renderModal(rule);
  const dialog = await screen.findByRole('dialog', { name: /edit assignment rule/i });
  expect((within(dialog).getByLabelText('Packet') as HTMLInputElement).value).toBe('Retired packet');
  expect(within(dialog).getByText(/this packet is archived/i)).toBeTruthy();
});

it('a failure stays in the dialog with the server wording', async () => {
  api.createLearningRule.mockRejectedValueOnce(new ApiError(
    422, 'bad_packet', { code: 'bad_packet', message: 'x' }));
  const user = userEvent.setup();
  renderModal();
  const dialog = await screen.findByRole('dialog', { name: /new assignment rule/i });
  fireEvent.change(within(dialog).getByLabelText('Rule name'), { target: { value: 'R' } });
  await waitFor(() => expect(api.listLearningPackets).toHaveBeenCalled());
  await pick(dialog, 'Packet', 'Standard onboarding');
  fireEvent.change(within(dialog).getByLabelText('Condition 1 field'), { target: { value: 'everyone' } });
  await user.click(within(dialog).getByRole('button', { name: 'Create rule' }));
  expect(await within(dialog).findByText(/packet that exists and isn.t archived/i)).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
});
