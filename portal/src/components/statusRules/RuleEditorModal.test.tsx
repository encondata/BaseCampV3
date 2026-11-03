// @vitest-environment jsdom
/**
 * RuleEditorModal — schema-driven create/edit builder for status rules.
 * Covers: the exact StatusRuleIn payload built on create, the Save-gate
 * (name + trigger + >=1 action), the needs_value operator hiding the
 * value control, edit-mode prefill + updateStatusRule wiring, and the
 * detail-code error surface (a bad_action says why through its reason).
 *
 * Controls: every dropdown is the house ComboBox (no native <select>); a
 * yes/no value reads Yes / No and a new one starts at "true". A yes/no field
 * offers the operator "equals", and one that can be empty (Asset has rails)
 * the two empty checks too (a stored condition with any other keeps it). The
 * Send a notification action's People and Groups are ChipPickers and its
 * watchers a Switch; a rule has one such action, so no other row offers it.
 * Their lists are asked for only by a viewer who may have them.
 */

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, type NotificationGroup, type NotificationRecipient, type RuleSchemaAction,
  type StatusRule, type StatusRuleSchema,
} from '../../lib/api';

const api = vi.hoisted(() => ({
  createStatusRule: vi.fn(),
  updateStatusRule: vi.fn(),
  listNotificationRecipients: vi.fn(),
  listNotificationGroups: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

/** What the signed-in viewer may do: everything, unless a test narrows it. */
const auth = vi.hoisted(() => ({
  can: (_resource: string, _action?: string): boolean => true,
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can }),
}));

const NOTIFY_ACTION: RuleSchemaAction = {
  key: 'notify', label: 'Send a notification',
  params: [
    { name: 'people', type: 'people' },
    { name: 'groups', type: 'groups' },
    { name: 'watchers', type: 'bool' },
  ],
};

const SCHEMA: StatusRuleSchema = {
  trigger_statuses: [
    { value: 'in_transit', label: 'In Transit', color: '#3b82f6' },
    { value: 'delivered', label: 'Delivered', color: '#22c55e' },
  ],
  match_types: [
    { value: 'exact', label: 'Exact' },
    { value: 'fuzzy', label: 'Fuzzy' },
  ],
  operators: [
    { key: 'equals', label: 'equals', needs_value: true },
    { key: 'not_equals', label: 'not equals', needs_value: true },
    { key: 'is_null', label: 'is null', needs_value: false },
    { key: 'is_not_null', label: 'is not null', needs_value: false },
  ],
  condition_fields: [
    {
      key: 'asset.status', label: 'Asset status', type: 'status',
      options: [{ value: 'good', label: 'Good' }, { value: 'bad', label: 'Bad' }],
    },
    { key: 'scan.device_id', label: 'Scan device', type: 'text' },
    // the two yes/no fields, as the API sends them: one is never empty, one can be
    { key: 'scan.off_move', label: 'Off-move sighting', type: 'bool', nullable: false },
    { key: 'asset.has_rails', label: 'Asset has rails', type: 'bool', nullable: true },
  ],
  actions: [
    {
      key: 'set_asset_status', label: 'Set asset status',
      params: [{
        name: 'status', type: 'status',
        options: [{ value: 'good', label: 'Good' }, { value: 'bad', label: 'Bad' }],
      }],
    },
    {
      key: 'set_initiative_asset_verified', label: 'Mark move asset side verified',
      params: [
        { name: 'side', type: 'choice', options: ['source', 'destination'] },
        { name: 'value', type: 'bool' },
      ],
    },
    // last, as in the API's catalog
    NOTIFY_ACTION,
  ],
  sites: [],
};

const RULE: StatusRule = {
  id: 'rule-1', name: 'Existing rule', description: 'A rule',
  trigger_status: 'delivered', trigger_match_type: 'exact',
  priority: 20, enabled: true,
  conditions: [{ field: 'asset.status', operator: 'equals', value: 'bad' }],
  actions: [{ action_type: 'set_asset_status', params: { status: 'good' } }],
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};

const person = (person_id: string, display_name: string, job_title: string | null = null): NotificationRecipient => ({
  person_id, display_name, job_title, avatar_url: null, email: null, phone: null, has_account: true,
  can_email: true, can_text: false, can_push: true, can_web: true,
});
const group = (id: string, name: string): NotificationGroup => ({
  id, name, description: '', enabled: true, member_count: 2, created_at: '2026-01-01T00:00:00Z',
});
const PEOPLE = [person('p1', 'Person A', 'Engineer'), person('p2', 'Person B'), person('p3', 'Person C')];
const GROUPS = [group('g1', 'Group A'), group('g2', 'Group B')];

const WATCHERS = 'Also people watching the initiative or site';

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
  api.listNotificationRecipients.mockResolvedValue(PEOPLE);
  api.listNotificationGroups.mockResolvedValue(GROUPS);
});

afterEach(cleanup);

const { default: RuleEditorModal } = await import('./RuleEditorModal');

type User = ReturnType<typeof userEvent.setup>;

function renderCreate(schema: StatusRuleSchema = SCHEMA) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<RuleEditorModal schema={schema} rule={null} onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}

function renderEdit(rule: StatusRule = RULE) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<RuleEditorModal schema={SCHEMA} rule={rule} onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}

const combobox = (name: string) => screen.getByRole('combobox', { name }) as HTMLInputElement;

/** Open a dropdown and click one of its options (the menu portals out of the card). A picker
 *  whose list is on its way is off until it arrives. */
async function pick(user: User, field: string, option: string | RegExp) {
  const box = combobox(field);
  await waitFor(() => expect(box.disabled).toBe(false));
  await user.click(box);
  await user.click(await screen.findByRole('button', { name: option }));
}

/** The names of the options a dropdown offers, opened and closed again. */
async function offered(user: User, field: string): Promise<string[]> {
  await user.click(combobox(field));
  const names = (await screen.findAllByRole('button'))
    .filter((b) => b.classList.contains('kbar-item'))
    .map((b) => b.textContent ?? '');
  await user.keyboard('{Escape}');
  return names;
}

async function fillBasics(user: User, name = 'New rule') {
  await user.type(screen.getByLabelText('Name'), name);
  await pick(user, 'When a scan with status', 'In Transit');
  await pick(user, 'matches a', 'Fuzzy');
}

const createRule = (user: User) => user.click(screen.getByRole('button', { name: /Create rule/i }));

const body = (over: Partial<StatusRule> = {}) => ({
  name: 'New rule', description: '',
  trigger_status: 'in_transit', trigger_match_type: 'fuzzy',
  priority: 10, enabled: true,
  conditions: [], actions: [],
  ...over,
});

it('create mode: fills basics + trigger, adds one action, submits the exact StatusRuleIn payload', async () => {
  const user = userEvent.setup();
  api.createStatusRule.mockResolvedValue({ ...RULE, id: 'new-1' });
  const { onSaved } = renderCreate();

  await fillBasics(user);

  await user.click(screen.getByRole('button', { name: 'Add action' }));
  await pick(user, 'Action 1 status', 'Bad');

  await createRule(user);

  await waitFor(() => expect(api.createStatusRule).toHaveBeenCalledTimes(1));
  expect(api.createStatusRule).toHaveBeenCalledWith(body({
    actions: [{ action_type: 'set_asset_status', params: { status: 'bad' } }],
  }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

it('disables Save until name, trigger status, trigger match type, and >=1 action are all present', async () => {
  const user = userEvent.setup();
  renderCreate();

  const save = screen.getByRole('button', { name: /Create rule/i }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);

  await user.type(screen.getByLabelText('Name'), 'Rule name');
  expect(save.disabled).toBe(true);

  await pick(user, 'When a scan with status', 'In Transit');
  expect(save.disabled).toBe(true);

  await pick(user, 'matches a', 'Fuzzy');
  expect(save.disabled).toBe(true); // still no actions

  await user.click(screen.getByRole('button', { name: 'Add action' }));
  expect(save.disabled).toBe(false);
});

it('the trigger status shows its chip once picked', async () => {
  const user = userEvent.setup();
  renderCreate();
  expect(document.querySelector('.chip.custom')).toBeNull();

  await pick(user, 'When a scan with status', 'Delivered');

  expect(document.querySelector('.chip.custom')?.textContent).toBe('Delivered');
});

it('condition row: selecting operator "is_null" hides the value control', async () => {
  const user = userEvent.setup();
  renderCreate();

  await user.click(screen.getByRole('button', { name: 'Add condition' }));
  expect(screen.getByLabelText('Condition 1 value')).not.toBeNull();

  await pick(user, 'Condition 1 operator', 'is null');
  expect(screen.queryByLabelText('Condition 1 value')).toBeNull();
});

it('condition row: field change preserves null value when operator needs_value is false', async () => {
  const user = userEvent.setup();
  api.createStatusRule.mockResolvedValue({ ...RULE, id: 'new-1' });
  const { onSaved } = renderCreate();

  await fillBasics(user, 'Test rule');

  await user.click(screen.getByRole('button', { name: 'Add condition' }));
  await pick(user, 'Condition 1 operator', 'is null');
  await pick(user, 'Condition 1 field', 'Scan device');

  await user.click(screen.getByRole('button', { name: 'Add action' }));
  await pick(user, 'Action 1 status', 'Bad');

  await createRule(user);

  await waitFor(() => expect(api.createStatusRule).toHaveBeenCalledTimes(1));
  expect(api.createStatusRule).toHaveBeenCalledWith(body({
    name: 'Test rule',
    conditions: [{ field: 'scan.device_id', operator: 'is_null', value: null }],
    actions: [{ action_type: 'set_asset_status', params: { status: 'bad' } }],
  }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

it('edit mode: prefills fields from the rule prop and submits updateStatusRule(rule.id, …)', async () => {
  const user = userEvent.setup();
  api.updateStatusRule.mockResolvedValue(RULE);
  const { onSaved } = renderEdit();

  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Existing rule');
  expect(combobox('When a scan with status').value).toBe('Delivered');
  expect(combobox('matches a').value).toBe('Exact');
  expect(combobox('Condition 1 field').value).toBe('Asset status');
  expect(combobox('Condition 1 operator').value).toBe('equals');
  expect(combobox('Condition 1 value').value).toBe('Bad');
  expect(combobox('Action 1 type').value).toBe('Set asset status');
  expect(combobox('Action 1 status').value).toBe('Good');

  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.updateStatusRule).toHaveBeenCalledTimes(1));
  expect(api.updateStatusRule).toHaveBeenCalledWith('rule-1', {
    name: 'Existing rule', description: 'A rule',
    trigger_status: 'delivered', trigger_match_type: 'exact',
    priority: 20, enabled: true,
    conditions: [{ field: 'asset.status', operator: 'equals', value: 'bad' }],
    actions: [{ action_type: 'set_asset_status', params: { status: 'good' } }],
  });
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

// ── errors ────────────────────────────────────────────────────────────

it('shows the detail-code error text when the api call rejects', async () => {
  const user = userEvent.setup();
  api.updateStatusRule.mockRejectedValue(new ApiError(422, 'bad_action'));
  renderEdit();

  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('One of the actions is invalid.')).not.toBeNull();
});

const badAction = (reason: string) =>
  new ApiError(422, 'bad_action', { code: 'bad_action', index: 0, reason });

it.each([
  ['notify_no_recipients', 'Pick people, groups or watchers.'],
  ['unknown_person', 'A chosen person no longer exists.'],
  ['unknown_group', 'A chosen group no longer exists.'],
  // the editor never offers a second Notify: a safety net, in the house fallback words
  ['notify_twice', 'Request failed (notify_twice).'],
  // every other reason keeps the general text
  ['bad_param', 'One of the actions is invalid.'],
  ['unknown_status_key', 'One of the actions is invalid.'],
])('a bad_action refused for %s reads "%s"', async (reason, text) => {
  const user = userEvent.setup();
  api.updateStatusRule.mockRejectedValue(badAction(reason));
  renderEdit();

  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText(text)).not.toBeNull();
});

it('a reason only changes the text of a bad_action', async () => {
  const user = userEvent.setup();
  api.updateStatusRule.mockRejectedValue(
    new ApiError(422, 'bad_condition', { code: 'bad_condition', index: 0, reason: 'unknown_person' }));
  renderEdit();

  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('One of the conditions is invalid.')).not.toBeNull();
});

it('the error from a refused save goes when the next save goes through', async () => {
  const user = userEvent.setup();
  api.updateStatusRule.mockRejectedValueOnce(badAction('unknown_group')).mockResolvedValue(RULE);
  const { onSaved } = renderEdit();

  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('A chosen group no longer exists.')).not.toBeNull();

  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('A chosen group no longer exists.')).toBeNull();
});

// ── the house controls ────────────────────────────────────────────────

it('has no native <select> anywhere: every dropdown is the house ComboBox', async () => {
  const user = userEvent.setup();
  renderCreate();
  await fillBasics(user);

  await user.click(screen.getByRole('button', { name: 'Add condition' }));
  await user.click(screen.getByRole('button', { name: 'Add action' }));
  expect(document.querySelectorAll('select')).toHaveLength(0);
  for (const name of [
    'When a scan with status', 'matches a', 'Condition 1 field', 'Condition 1 operator',
    'Condition 1 value', 'Action 1 type', 'Action 1 status',
  ]) {
    expect(combobox(name).tagName).toBe('INPUT');
  }

  // a choice, a yes/no parameter, and the notification's pickers
  await pick(user, 'Action 1 type', 'Mark move asset side verified');
  expect(document.querySelectorAll('select')).toHaveLength(0);
  expect(combobox('Action 1 side')).not.toBeNull();
  expect(combobox('Action 1 value')).not.toBeNull();
  await pick(user, 'Action 1 type', 'Send a notification');
  expect(document.querySelectorAll('select')).toHaveLength(0);
  expect(combobox('Action 1 people')).not.toBeNull();
  expect(combobox('Action 1 groups')).not.toBeNull();
});

it('shows no select on an edit of a rule either, and offers every option of a dropdown', async () => {
  const user = userEvent.setup();
  renderEdit();

  expect(document.querySelectorAll('select')).toHaveLength(0);
  expect(await offered(user, 'When a scan with status')).toEqual(['In Transit', 'Delivered']);
  expect(await offered(user, 'matches a')).toEqual(['Exact', 'Fuzzy']);
  expect(await offered(user, 'Condition 1 field'))
    .toEqual(['Asset status', 'Scan device', 'Off-move sighting', 'Asset has rails']);
  expect(await offered(user, 'Condition 1 operator'))
    .toEqual(['equals', 'not equals', 'is null', 'is not null']);
  expect(await offered(user, 'Condition 1 value')).toEqual(['Good', 'Bad']);
  expect(await offered(user, 'Action 1 type')).toEqual([
    'Set asset status', 'Mark move asset side verified', 'Send a notification',
  ]);
  expect(await offered(user, 'Action 1 status')).toEqual(['Good', 'Bad']);
});

it('a dropdown filters as you type', async () => {
  const user = userEvent.setup();
  renderCreate();

  await user.click(combobox('When a scan with status'));
  await user.type(combobox('When a scan with status'), 'deliv');

  const names = screen.getAllByRole('button').filter((b) => b.classList.contains('kbar-item'));
  expect(names.map((b) => b.textContent)).toEqual(['Delivered']);
});

it('choice and yes/no parameters are dropdowns, a yes/no one reading Yes / No', async () => {
  const user = userEvent.setup();
  api.createStatusRule.mockResolvedValue({ ...RULE, id: 'new-1' });
  renderCreate();
  await fillBasics(user);

  await user.click(screen.getByRole('button', { name: 'Add action' }));
  await pick(user, 'Action 1 type', 'Mark move asset side verified');
  // they start at the first choice and "No"
  expect(combobox('Action 1 side').value).toBe('source');
  expect(combobox('Action 1 value').value).toBe('No');
  expect(await offered(user, 'Action 1 value')).toEqual(['Yes', 'No']);

  await pick(user, 'Action 1 side', 'destination');
  await pick(user, 'Action 1 value', 'Yes');
  expect(combobox('Action 1 side').value).toBe('destination');
  expect(combobox('Action 1 value').value).toBe('Yes');

  await createRule(user);
  await waitFor(() => expect(api.createStatusRule).toHaveBeenCalledTimes(1));
  expect(api.createStatusRule).toHaveBeenCalledWith(body({
    actions: [{
      action_type: 'set_initiative_asset_verified',
      params: { side: 'destination', value: true },
    }],
  }));
});

it('changing the action type starts the new action on its own defaults', async () => {
  const user = userEvent.setup();
  api.createStatusRule.mockResolvedValue({ ...RULE, id: 'new-1' });
  renderCreate();
  await fillBasics(user);

  await user.click(screen.getByRole('button', { name: 'Add action' }));
  await pick(user, 'Action 1 status', 'Bad');
  await pick(user, 'Action 1 type', 'Mark move asset side verified');
  expect(screen.queryByRole('combobox', { name: 'Action 1 status' })).toBeNull();

  await createRule(user);
  await waitFor(() => expect(api.createStatusRule).toHaveBeenCalledTimes(1));
  expect(api.createStatusRule).toHaveBeenCalledWith(body({
    actions: [{
      action_type: 'set_initiative_asset_verified',
      params: { side: 'source', value: false },
    }],
  }));
});

it('picking the action type a row already has keeps its parameters', async () => {
  const user = userEvent.setup();
  renderCreate();
  await user.click(screen.getByRole('button', { name: 'Add action' }));
  await pick(user, 'Action 1 type', 'Mark move asset side verified');
  await pick(user, 'Action 1 side', 'destination');
  await pick(user, 'Action 1 value', 'Yes');

  await pick(user, 'Action 1 type', 'Mark move asset side verified');

  expect(combobox('Action 1 side').value).toBe('destination');
  expect(combobox('Action 1 value').value).toBe('Yes');
});

it('picking the field or the operator a condition already has keeps its value', async () => {
  const user = userEvent.setup();
  renderCreate();
  await user.click(screen.getByRole('button', { name: 'Add condition' }));
  await pick(user, 'Condition 1 field', 'Scan device');
  await user.type(screen.getByLabelText('Condition 1 value'), 'dock-1');

  await pick(user, 'Condition 1 field', 'Scan device');
  await pick(user, 'Condition 1 operator', 'equals');

  expect((screen.getByLabelText('Condition 1 value') as HTMLInputElement).value).toBe('dock-1');
});

it('the controls go off while a save is under way', async () => {
  const user = userEvent.setup();
  let release: (r: StatusRule) => void = () => undefined;
  api.updateStatusRule.mockReturnValue(new Promise<StatusRule>((resolve) => { release = resolve; }));
  renderEdit();

  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(combobox('matches a').disabled).toBe(true));
  expect(combobox('Condition 1 value').disabled).toBe(true);
  expect(combobox('Action 1 type').disabled).toBe(true);
  expect(combobox('Action 1 status').disabled).toBe(true);
  await act(async () => { release(RULE); });
});

// ── yes/no conditions ────────────────────────────────────────────────

it('the Off-move sighting field reads Yes / No, not true / false', async () => {
  const user = userEvent.setup();
  api.createStatusRule.mockResolvedValue({ ...RULE, id: 'new-1' });
  renderCreate();
  await fillBasics(user);

  await user.click(screen.getByRole('button', { name: 'Add condition' }));
  await pick(user, 'Condition 1 field', 'Off-move sighting');
  expect(combobox('Condition 1 field').value).toBe('Off-move sighting');
  expect(combobox('Condition 1 value').value).toBe('Yes');
  expect(await offered(user, 'Condition 1 value')).toEqual(['Yes', 'No']);

  await pick(user, 'Condition 1 value', 'No');
  expect(combobox('Condition 1 value').value).toBe('No');

  await user.click(screen.getByRole('button', { name: 'Add action' }));
  await createRule(user);
  await waitFor(() => expect(api.createStatusRule).toHaveBeenCalledTimes(1));
  expect(api.createStatusRule).toHaveBeenCalledWith(body({
    conditions: [{ field: 'scan.off_move', operator: 'equals', value: 'false' }],
    actions: [{ action_type: 'set_asset_status', params: { status: 'good' } }],
  }));
});

it('a new condition on a yes/no field starts at "true": untouched, it saves true', async () => {
  const user = userEvent.setup();
  api.createStatusRule.mockResolvedValue({ ...RULE, id: 'new-1' });
  renderCreate();
  await fillBasics(user);

  await user.click(screen.getByRole('button', { name: 'Add condition' }));
  await pick(user, 'Condition 1 field', 'Off-move sighting');
  await user.click(screen.getByRole('button', { name: 'Add action' }));
  await createRule(user);

  await waitFor(() => expect(api.createStatusRule).toHaveBeenCalledTimes(1));
  expect(api.createStatusRule).toHaveBeenCalledWith(body({
    conditions: [{ field: 'scan.off_move', operator: 'equals', value: 'true' }],
    actions: [{ action_type: 'set_asset_status', params: { status: 'good' } }],
  }));
});

it.each(['scan.off_move', 'asset.has_rails'])(
  'a yes/no value starts at "true" again when a stored operator that takes none (on %s) gives way to equals',
  async (field) => {
    const user = userEvent.setup();
    renderEdit({ ...RULE, conditions: [{ field, operator: 'is_null', value: null }] });
    expect(screen.queryByRole('combobox', { name: 'Condition 1 value' })).toBeNull();

    await pick(user, 'Condition 1 operator', 'equals');

    expect(combobox('Condition 1 value').value).toBe('Yes');
  },
);

// ── a yes/no field offers "equals", and the empty checks only if it can be empty ─────────

it('a yes/no field that is never empty offers only the operator "equals"; every other field offers them all', async () => {
  const user = userEvent.setup();
  renderCreate();
  await user.click(screen.getByRole('button', { name: 'Add condition' }));
  const everyOperator = ['equals', 'not equals', 'is null', 'is not null'];

  // Asset status (a status field) is the first field
  expect(await offered(user, 'Condition 1 operator')).toEqual(everyOperator);
  await pick(user, 'Condition 1 field', 'Off-move sighting');
  expect(await offered(user, 'Condition 1 operator')).toEqual(['equals']);
  await pick(user, 'Condition 1 field', 'Scan device');
  expect(await offered(user, 'Condition 1 operator')).toEqual(everyOperator);
});

it('a yes/no field that can be empty (Asset has rails) offers "equals" and the two empty checks, and no others', async () => {
  const user = userEvent.setup();
  renderCreate();
  await user.click(screen.getByRole('button', { name: 'Add condition' }));

  await pick(user, 'Condition 1 field', 'Asset has rails');

  expect(await offered(user, 'Condition 1 operator')).toEqual(['equals', 'is null', 'is not null']);
});

it('a yes/no field that does not say whether it can be empty offers only "equals" (an older payload)', async () => {
  const user = userEvent.setup();
  const [status, device] = SCHEMA.condition_fields;
  renderCreate({
    ...SCHEMA,
    condition_fields: [
      status, device, { key: 'scan.off_move', label: 'Off-move sighting', type: 'bool' },
    ],
  });
  await user.click(screen.getByRole('button', { name: 'Add condition' }));

  await pick(user, 'Condition 1 field', 'Off-move sighting');

  expect(await offered(user, 'Condition 1 operator')).toEqual(['equals']);
});

it('a condition moved onto a yes/no field takes "equals" and starts at Yes, whatever operator it had', async () => {
  const user = userEvent.setup();
  api.createStatusRule.mockResolvedValue({ ...RULE, id: 'new-1' });
  renderCreate();
  await fillBasics(user);
  await user.click(screen.getByRole('button', { name: 'Add condition' }));

  await pick(user, 'Condition 1 operator', 'not equals');
  await pick(user, 'Condition 1 field', 'Off-move sighting');
  expect(combobox('Condition 1 operator').value).toBe('equals');
  expect(combobox('Condition 1 value').value).toBe('Yes');

  // one that takes no value: the value box comes back
  await pick(user, 'Condition 1 field', 'Scan device');
  await pick(user, 'Condition 1 operator', 'is null');
  expect(screen.queryByLabelText('Condition 1 value')).toBeNull();
  await pick(user, 'Condition 1 field', 'Off-move sighting');
  expect(combobox('Condition 1 operator').value).toBe('equals');
  expect(combobox('Condition 1 value').value).toBe('Yes');

  await user.click(screen.getByRole('button', { name: 'Add action' }));
  await createRule(user);
  await waitFor(() => expect(api.createStatusRule).toHaveBeenCalledTimes(1));
  expect(api.createStatusRule).toHaveBeenCalledWith(body({
    conditions: [{ field: 'scan.off_move', operator: 'equals', value: 'true' }],
    actions: [{ action_type: 'set_asset_status', params: { status: 'good' } }],
  }));
});

it('a condition moved onto a yes/no field that can be empty takes "equals" too, though it offers the empty checks', async () => {
  const user = userEvent.setup();
  renderCreate();
  await user.click(screen.getByRole('button', { name: 'Add condition' }));
  await pick(user, 'Condition 1 field', 'Scan device');
  await pick(user, 'Condition 1 operator', 'is not null');
  expect(screen.queryByLabelText('Condition 1 value')).toBeNull();

  await pick(user, 'Condition 1 field', 'Asset has rails');

  expect(combobox('Condition 1 operator').value).toBe('equals');
  expect(combobox('Condition 1 value').value).toBe('Yes');
});

it('Asset has rails can be asked about as unknown or known: the empty checks save with no value', async () => {
  const user = userEvent.setup();
  api.createStatusRule.mockResolvedValue({ ...RULE, id: 'new-1' });
  renderCreate();
  await fillBasics(user);
  await user.click(screen.getByRole('button', { name: 'Add condition' }));
  await pick(user, 'Condition 1 field', 'Asset has rails');
  await user.click(screen.getByRole('button', { name: 'Add condition' }));
  await pick(user, 'Condition 2 field', 'Asset has rails');

  await pick(user, 'Condition 1 operator', 'is null');
  await pick(user, 'Condition 2 operator', 'is not null');
  expect(screen.queryByLabelText('Condition 1 value')).toBeNull();
  expect(screen.queryByLabelText('Condition 2 value')).toBeNull();
  // and back to a Yes / No question: the value starts at Yes again
  await pick(user, 'Condition 2 operator', 'equals');
  expect(combobox('Condition 2 value').value).toBe('Yes');
  await pick(user, 'Condition 2 value', 'No');

  await user.click(screen.getByRole('button', { name: 'Add action' }));
  await createRule(user);
  await waitFor(() => expect(api.createStatusRule).toHaveBeenCalledTimes(1));
  expect(api.createStatusRule).toHaveBeenCalledWith(body({
    conditions: [
      { field: 'asset.has_rails', operator: 'is_null', value: null },
      { field: 'asset.has_rails', operator: 'equals', value: 'false' },
    ],
    actions: [{ action_type: 'set_asset_status', params: { status: 'good' } }],
  }));
});

it.each(['Off-move sighting', 'Asset has rails'])(
  'a new condition starts on "equals" when the first field is a yes/no one (%s)',
  async (label) => {
    const user = userEvent.setup();
    const [status, device, ...yesNo] = SCHEMA.condition_fields;
    const first = yesNo.find((f) => f.label === label)!;
    const [equals, notEquals, isNull] = SCHEMA.operators;
    renderCreate({
      ...SCHEMA,
      condition_fields: [first, status, device],
      operators: [isNull, notEquals, equals],      // the first one that takes a value isn't "equals"
    });

    await user.click(screen.getByRole('button', { name: 'Add condition' }));

    expect(combobox('Condition 1 field').value).toBe(label);
    expect(combobox('Condition 1 operator').value).toBe('equals');
    expect(combobox('Condition 1 value').value).toBe('Yes');
  },
);

it('a stored condition on a yes/no field with another operator keeps it: the box reads blank and a save sends it as stored', async () => {
  const user = userEvent.setup();
  api.updateStatusRule.mockResolvedValue(RULE);
  const stored = { field: 'scan.off_move', operator: 'not_equals', value: 'false' };
  renderEdit({ ...RULE, conditions: [stored] });

  expect(combobox('Condition 1 operator').value).toBe('');
  expect(combobox('Condition 1 value').value).toBe('No');
  expect(await offered(user, 'Condition 1 operator')).toEqual(['equals']);
  expect(combobox('Condition 1 operator').value).toBe('');

  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateStatusRule).toHaveBeenCalledTimes(1));
  expect(api.updateStatusRule.mock.calls[0][1].conditions).toEqual([stored]);
});

it('on Asset has rails a stored empty check reads as itself, and a stored "not equals" reads blank; both save as stored', async () => {
  const user = userEvent.setup();
  api.updateStatusRule.mockResolvedValue(RULE);
  const empty = { field: 'asset.has_rails', operator: 'is_null', value: null };
  const other = { field: 'asset.has_rails', operator: 'not_equals', value: 'true' };
  renderEdit({ ...RULE, conditions: [empty, other] });

  expect(combobox('Condition 1 operator').value).toBe('is null');
  expect(screen.queryByLabelText('Condition 1 value')).toBeNull();
  expect(combobox('Condition 2 operator').value).toBe('');
  expect(combobox('Condition 2 value').value).toBe('Yes');

  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateStatusRule).toHaveBeenCalledTimes(1));
  expect(api.updateStatusRule.mock.calls[0][1].conditions).toEqual([empty, other]);
});

it('a field with choices starts empty, and a text field too: only a yes/no field starts at a value', async () => {
  const user = userEvent.setup();
  renderCreate();
  await user.click(screen.getByRole('button', { name: 'Add condition' }));

  // Asset status (a status field) is the first field
  expect(combobox('Condition 1 value').value).toBe('');
  await pick(user, 'Condition 1 value', 'Good');
  await pick(user, 'Condition 1 field', 'Scan device');
  expect((screen.getByLabelText('Condition 1 value') as HTMLInputElement).value).toBe('');
  expect(screen.getByLabelText('Condition 1 value').tagName).toBe('INPUT');
  expect(screen.queryByRole('combobox', { name: 'Condition 1 value' })).toBeNull();
});

// ── Send a notification ──────────────────────────────────────────────

async function addNotify(user: User) {
  await user.click(screen.getByRole('button', { name: 'Add action' }));
  await pick(user, 'Action 1 type', 'Send a notification');
}

it('Send a notification: People, Groups and a switch for the people watching, as the mockup words them', async () => {
  const user = userEvent.setup();
  renderCreate();
  await addNotify(user);

  const more = screen.getByText('People').closest('.rule-action') as HTMLElement;
  expect(within(more).getByText('People').tagName).toBe('LABEL');
  expect(within(more).getByText('Groups').tagName).toBe('LABEL');
  expect(within(more).getByPlaceholderText('Search people…')).toBe(combobox('Action 1 people'));
  expect(within(more).getByPlaceholderText('Search groups…')).toBe(combobox('Action 1 groups'));
  expect(within(more).getByText(WATCHERS).tagName).toBe('SPAN');
  const watchers = screen.getByRole('checkbox', { name: WATCHERS }) as HTMLInputElement;
  expect(watchers.checked).toBe(false);
  expect(more.contains(watchers)).toBe(true);
});

it('Send a notification: picking people, groups and watchers saves {people, groups, watchers}', async () => {
  const user = userEvent.setup();
  api.createStatusRule.mockResolvedValue({ ...RULE, id: 'new-1' });
  const { onSaved } = renderCreate();
  await fillBasics(user, 'Tell people');
  await addNotify(user);

  await pick(user, 'Action 1 people', /^Person B/);
  await pick(user, 'Action 1 people', /^Person A/);
  await pick(user, 'Action 1 groups', /^Group B/);
  await user.click(screen.getByRole('checkbox', { name: WATCHERS }));

  // each pick is a chip with a ×, in the order picked
  expect(screen.getByRole('button', { name: 'Remove Person B' })).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Remove Person A' })).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Remove Group B' })).not.toBeNull();
  expect((screen.getByRole('checkbox', { name: WATCHERS }) as HTMLInputElement).checked).toBe(true);

  await createRule(user);

  await waitFor(() => expect(api.createStatusRule).toHaveBeenCalledTimes(1));
  expect(api.createStatusRule).toHaveBeenCalledWith(body({
    name: 'Tell people',
    actions: [{
      action_type: 'notify',
      params: { people: ['p2', 'p1'], groups: ['g2'], watchers: true },
    }],
  }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

it('Send a notification: a chip comes off with its ×, and the switch turns back off', async () => {
  const user = userEvent.setup();
  api.createStatusRule.mockResolvedValue({ ...RULE, id: 'new-1' });
  renderCreate();
  await fillBasics(user);
  await addNotify(user);

  await pick(user, 'Action 1 people', /^Person A/);
  await pick(user, 'Action 1 people', /^Person C/);
  await pick(user, 'Action 1 groups', /^Group A/);
  await user.click(screen.getByRole('checkbox', { name: WATCHERS }));
  await user.click(screen.getByRole('button', { name: 'Remove Person A' }));
  await user.click(screen.getByRole('button', { name: 'Remove Group A' }));
  await user.click(screen.getByRole('checkbox', { name: WATCHERS }));
  await pick(user, 'Action 1 people', /^Person B/);

  await createRule(user);
  await waitFor(() => expect(api.createStatusRule).toHaveBeenCalledTimes(1));
  expect(api.createStatusRule).toHaveBeenCalledWith(body({
    actions: [{
      action_type: 'notify',
      params: { people: ['p3', 'p2'], groups: [], watchers: false },
    }],
  }));
});

it('Send a notification: the options name each person, with their job title beside it', async () => {
  const user = userEvent.setup();
  renderCreate();
  await addNotify(user);

  await waitFor(() => expect(combobox('Action 1 people').disabled).toBe(false));
  await user.click(combobox('Action 1 people'));

  const options = (await screen.findAllByRole('button'))
    .filter((b) => b.classList.contains('kbar-item'));
  expect(options.map((b) => b.firstChild?.textContent)).toEqual(['Person A', 'Person B', 'Person C']);
  expect(options[0].querySelector('.sub')?.textContent).toBe('Engineer');
  expect(options[1].querySelector('.sub')).toBeNull();
});

it('Send a notification: a new one starts with nobody picked and the switch off', async () => {
  const user = userEvent.setup();
  api.createStatusRule.mockRejectedValue(badAction('notify_no_recipients'));
  renderCreate();
  await fillBasics(user);
  await addNotify(user);

  await createRule(user);

  await waitFor(() => expect(api.createStatusRule).toHaveBeenCalledTimes(1));
  expect(api.createStatusRule).toHaveBeenCalledWith(body({
    actions: [{ action_type: 'notify', params: { people: [], groups: [], watchers: false } }],
  }));
});

it('Send a notification: with none picked, the save error is "Pick people, groups or watchers."', async () => {
  const user = userEvent.setup();
  api.createStatusRule.mockRejectedValue(badAction('notify_no_recipients'));
  const { onSaved } = renderCreate();
  await fillBasics(user);
  await addNotify(user);

  await createRule(user);

  const error = await screen.findByText('Pick people, groups or watchers.');
  expect(error.classList.contains('pf-error')).toBe(true);
  expect(onSaved).not.toHaveBeenCalled();
  // and it is the only place the sentence is: it is not a hint shown before a save
  expect(screen.getAllByText('Pick people, groups or watchers.')).toHaveLength(1);
});

it('Send a notification: the picked names come up when an existing rule is edited, and save unchanged', async () => {
  const user = userEvent.setup();
  api.updateStatusRule.mockResolvedValue(RULE);
  const notifyRule: StatusRule = {
    ...RULE,
    actions: [{ action_type: 'notify', params: { people: ['p1', 'p3'], groups: ['g1'], watchers: true } }],
  };
  renderEdit(notifyRule);

  // the lists are asked for at once: the rule already has the action
  expect(await screen.findByRole('button', { name: 'Remove Person A' })).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Remove Person C' })).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Remove Group A' })).not.toBeNull();
  expect(screen.queryByText('p1')).toBeNull();
  expect((screen.getByRole('checkbox', { name: WATCHERS }) as HTMLInputElement).checked).toBe(true);
  expect(combobox('Action 1 type').value).toBe('Send a notification');

  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.updateStatusRule).toHaveBeenCalledTimes(1));
  expect(api.updateStatusRule).toHaveBeenCalledWith('rule-1', {
    name: 'Existing rule', description: 'A rule',
    trigger_status: 'delivered', trigger_match_type: 'exact',
    priority: 20, enabled: true,
    conditions: [{ field: 'asset.status', operator: 'equals', value: 'bad' }],
    actions: [{ action_type: 'notify', params: { people: ['p1', 'p3'], groups: ['g1'], watchers: true } }],
  });
});

it('Send a notification: a person or group no longer on the lists shows as its id, and can be taken off', async () => {
  const user = userEvent.setup();
  api.updateStatusRule.mockResolvedValue(RULE);
  renderEdit({
    ...RULE,
    actions: [{ action_type: 'notify', params: { people: ['p9'], groups: [], watchers: false } }],
  });

  await user.click(await screen.findByRole('button', { name: 'Remove p9' }));
  await user.click(screen.getByRole('checkbox', { name: WATCHERS }));
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.updateStatusRule).toHaveBeenCalledTimes(1));
  expect(api.updateStatusRule.mock.calls[0][1].actions).toEqual([
    { action_type: 'notify', params: { people: [], groups: [], watchers: true } },
  ]);
});

it('Send a notification: the pickers are off until their lists are in', async () => {
  const user = userEvent.setup();
  let people: (v: NotificationRecipient[]) => void = () => undefined;
  let groups: (v: NotificationGroup[]) => void = () => undefined;
  api.listNotificationRecipients.mockReturnValue(new Promise((resolve) => { people = resolve; }));
  api.listNotificationGroups.mockReturnValue(new Promise((resolve) => { groups = resolve; }));
  renderCreate();
  await addNotify(user);

  expect(combobox('Action 1 people').disabled).toBe(true);
  expect(combobox('Action 1 groups').disabled).toBe(true);

  people(PEOPLE);
  await waitFor(() => expect(combobox('Action 1 people').disabled).toBe(false));
  expect(combobox('Action 1 groups').disabled).toBe(true);
  groups(GROUPS);
  await waitFor(() => expect(combobox('Action 1 groups').disabled).toBe(false));
});

it('the lists are asked for only once a Send a notification action is there, and once', async () => {
  const user = userEvent.setup();
  renderCreate();
  await user.click(screen.getByRole('button', { name: 'Add action' }));
  expect(api.listNotificationRecipients).not.toHaveBeenCalled();
  expect(api.listNotificationGroups).not.toHaveBeenCalled();

  await pick(user, 'Action 1 type', 'Send a notification');
  await waitFor(() => expect(api.listNotificationRecipients).toHaveBeenCalledTimes(1));
  expect(api.listNotificationGroups).toHaveBeenCalledTimes(1);

  // away and back: the lists are in
  await pick(user, 'Action 1 type', 'Set asset status');
  await pick(user, 'Action 1 type', 'Send a notification');
  await waitFor(() => expect(combobox('Action 1 people').disabled).toBe(false));
  expect(api.listNotificationRecipients).toHaveBeenCalledTimes(1);
  expect(api.listNotificationGroups).toHaveBeenCalledTimes(1);
});

it('a rule with no Send a notification action never asks for the lists', async () => {
  renderEdit();
  await waitFor(() => expect(combobox('Action 1 status').value).toBe('Good'));

  expect(api.listNotificationRecipients).not.toHaveBeenCalled();
  expect(api.listNotificationGroups).not.toHaveBeenCalled();
});

it('Send a notification: a list that does not load is named beside its picker, the other stays usable', async () => {
  const user = userEvent.setup();
  api.listNotificationRecipients.mockRejectedValue(new ApiError(403, 'forbidden'));
  api.createStatusRule.mockResolvedValue({ ...RULE, id: 'new-1' });
  renderCreate();
  await fillBasics(user);
  await addNotify(user);

  const note = await screen.findByText('Could not load the recipient list.');
  expect(note.classList.contains('pf-error')).toBe(true);
  expect(screen.queryByText('Could not load the group list.')).toBeNull();
  expect(combobox('Action 1 people').disabled).toBe(false);   // not left off for ever

  await pick(user, 'Action 1 groups', /^Group A/);
  await createRule(user);
  await waitFor(() => expect(api.createStatusRule).toHaveBeenCalledTimes(1));
  expect(api.createStatusRule.mock.calls[0][0].actions).toEqual([
    { action_type: 'notify', params: { people: [], groups: ['g1'], watchers: false } },
  ]);
});

it('Send a notification: the group list not loading is named in the same way', async () => {
  const user = userEvent.setup();
  api.listNotificationGroups.mockRejectedValue(new Error('Failed to fetch'));
  renderCreate();
  await addNotify(user);

  expect(await screen.findByText('Could not load the group list.')).not.toBeNull();
  expect(screen.queryByText('Could not load the recipient list.')).toBeNull();
});

it('Send a notification: a viewer without notification permissions asks for no list, and each picker says it has none', async () => {
  const user = userEvent.setup();
  auth.can = (resource) => resource === 'status_rules';
  renderCreate();
  await addNotify(user);

  expect(await screen.findByText('Could not load the recipient list.')).not.toBeNull();
  expect(screen.getByText('Could not load the group list.')).not.toBeNull();
  expect(api.listNotificationRecipients).not.toHaveBeenCalled();
  expect(api.listNotificationGroups).not.toHaveBeenCalled();
  expect(combobox('Action 1 people').disabled).toBe(false);   // not left off for ever
  expect(combobox('Action 1 groups').disabled).toBe(false);
});

it('Send a notification: a rule edited without notification permissions shows its ids, and saves them unchanged', async () => {
  const user = userEvent.setup();
  auth.can = (resource) => resource === 'status_rules';
  api.updateStatusRule.mockResolvedValue(RULE);
  const notify = { people: ['p1'], groups: ['g1'], watchers: true };
  renderEdit({ ...RULE, actions: [{ action_type: 'notify', params: notify }] });

  expect(await screen.findByRole('button', { name: 'Remove p1' })).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Remove g1' })).not.toBeNull();
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.updateStatusRule).toHaveBeenCalledTimes(1));
  expect(api.updateStatusRule.mock.calls[0][1].actions).toEqual([
    { action_type: 'notify', params: notify },
  ]);
  expect(api.listNotificationRecipients).not.toHaveBeenCalled();
  expect(api.listNotificationGroups).not.toHaveBeenCalled();
});

// ── one Send a notification action per rule ──────────────────────────

it('once a rule has a Send a notification action, no other action row offers it', async () => {
  const user = userEvent.setup();
  renderCreate();
  await addNotify(user);
  await user.click(screen.getByRole('button', { name: 'Add action' }));

  // the second row leaves it out; the row that has it keeps it
  expect(await offered(user, 'Action 2 type'))
    .toEqual(['Set asset status', 'Mark move asset side verified']);
  expect(await offered(user, 'Action 1 type')).toEqual([
    'Set asset status', 'Mark move asset side verified', 'Send a notification',
  ]);
});

it('the notification action offers itself again once it is removed or changed', async () => {
  const user = userEvent.setup();
  renderCreate();
  await addNotify(user);
  await user.click(screen.getByRole('button', { name: 'Add action' }));
  expect(await offered(user, 'Action 2 type')).not.toContain('Send a notification');

  await user.click(screen.getByRole('button', { name: 'Remove action 1' }));
  expect(await offered(user, 'Action 1 type')).toContain('Send a notification');

  await pick(user, 'Action 1 type', 'Send a notification');
  await user.click(screen.getByRole('button', { name: 'Add action' }));
  expect(await offered(user, 'Action 2 type')).not.toContain('Send a notification');
  await pick(user, 'Action 1 type', 'Set asset status');
  expect(await offered(user, 'Action 2 type')).toContain('Send a notification');
});

it('a row always lists the type it has, even if the rule somehow holds two notifications', async () => {
  const user = userEvent.setup();
  const twice = { action_type: 'notify', params: { people: ['p1'], groups: [], watchers: false } };
  renderEdit({ ...RULE, actions: [twice, { ...twice, params: { ...twice.params, people: ['p2'] } }] });

  expect(combobox('Action 1 type').value).toBe('Send a notification');
  expect(combobox('Action 2 type').value).toBe('Send a notification');
  // and each can still be changed to anything else
  expect(await offered(user, 'Action 1 type')).toEqual([
    'Set asset status', 'Mark move asset side verified', 'Send a notification',
  ]);
});

it('a new action row never starts as a second Send a notification, whatever the schema lists first', async () => {
  const user = userEvent.setup();
  renderCreate({ ...SCHEMA, actions: [NOTIFY_ACTION, ...SCHEMA.actions.filter((a) => a.key !== 'notify')] });
  await user.click(screen.getByRole('button', { name: 'Add action' }));
  expect(combobox('Action 1 type').value).toBe('Send a notification');   // the first one may be

  await user.click(screen.getByRole('button', { name: 'Add action' }));

  expect(combobox('Action 2 type').value).toBe('Set asset status');
});

it('with only the notification action to offer, Add action goes off once the rule has one', async () => {
  const user = userEvent.setup();
  renderCreate({ ...SCHEMA, actions: [NOTIFY_ACTION] });
  const add = screen.getByRole('button', { name: 'Add action' }) as HTMLButtonElement;
  expect(add.disabled).toBe(false);

  await user.click(add);

  expect(add.disabled).toBe(true);
  expect(screen.queryByRole('combobox', { name: 'Action 2 type' })).toBeNull();
});

it('a rule keeps its action order: the notification can move up and down like any action', async () => {
  const user = userEvent.setup();
  api.createStatusRule.mockResolvedValue({ ...RULE, id: 'new-1' });
  renderCreate();
  await fillBasics(user);
  await user.click(screen.getByRole('button', { name: 'Add action' }));
  await user.click(screen.getByRole('button', { name: 'Add action' }));
  await pick(user, 'Action 2 type', 'Send a notification');
  await pick(user, 'Action 2 groups', /^Group A/);

  await user.click(screen.getByRole('button', { name: 'Move action 2 up' }));
  expect(combobox('Action 1 type').value).toBe('Send a notification');
  expect(combobox('Action 2 type').value).toBe('Set asset status');
  expect(screen.getByRole('button', { name: 'Remove Group A' })).not.toBeNull();

  await createRule(user);
  await waitFor(() => expect(api.createStatusRule).toHaveBeenCalledTimes(1));
  expect(api.createStatusRule.mock.calls[0][0].actions).toEqual([
    { action_type: 'notify', params: { people: [], groups: ['g1'], watchers: false } },
    { action_type: 'set_asset_status', params: { status: 'good' } },
  ]);
});
