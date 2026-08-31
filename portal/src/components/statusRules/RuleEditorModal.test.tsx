// @vitest-environment jsdom
/**
 * RuleEditorModal — schema-driven create/edit builder for status rules.
 * Covers: the exact StatusRuleIn payload built on create, the Save-gate
 * (name + trigger + >=1 action), the needs_value operator hiding the
 * value control, edit-mode prefill + updateStatusRule wiring, and the
 * detail-code error surface.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type StatusRule, type StatusRuleSchema } from '../../lib/api';

const api = vi.hoisted(() => ({
  createStatusRule: vi.fn(),
  updateStatusRule: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

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
    { key: 'is_null', label: 'is null', needs_value: false },
  ],
  condition_fields: [
    {
      key: 'asset.status', label: 'Asset status', type: 'status',
      options: [{ value: 'good', label: 'Good' }, { value: 'bad', label: 'Bad' }],
    },
    { key: 'scan.device_id', label: 'Scan device', type: 'text' },
  ],
  actions: [
    {
      key: 'set_asset_status', label: 'Set asset status',
      params: [{
        name: 'status', type: 'status',
        options: [{ value: 'good', label: 'Good' }, { value: 'bad', label: 'Bad' }],
      }],
    },
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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

const { default: RuleEditorModal } = await import('./RuleEditorModal');

function renderCreate() {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<RuleEditorModal schema={SCHEMA} rule={null} onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}

function renderEdit(rule: StatusRule = RULE) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<RuleEditorModal schema={SCHEMA} rule={rule} onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}

it('create mode: fills basics + trigger, adds one action, submits the exact StatusRuleIn payload', async () => {
  const user = userEvent.setup();
  api.createStatusRule.mockResolvedValue({ ...RULE, id: 'new-1' });
  const { onSaved } = renderCreate();

  await user.type(screen.getByLabelText('Name'), 'New rule');
  await user.selectOptions(screen.getByLabelText('When a scan with status'), 'in_transit');
  await user.selectOptions(screen.getByLabelText('matches a'), 'fuzzy');

  await user.click(screen.getByRole('button', { name: 'Add action' }));
  await user.selectOptions(screen.getByLabelText('Action 1 status'), 'bad');

  await user.click(screen.getByRole('button', { name: /Create rule/i }));

  await waitFor(() => expect(api.createStatusRule).toHaveBeenCalledTimes(1));
  expect(api.createStatusRule).toHaveBeenCalledWith({
    name: 'New rule', description: '',
    trigger_status: 'in_transit', trigger_match_type: 'fuzzy',
    priority: 10, enabled: true,
    conditions: [],
    actions: [{ action_type: 'set_asset_status', params: { status: 'bad' } }],
  });
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

it('disables Save until name, trigger status, trigger match type, and >=1 action are all present', async () => {
  const user = userEvent.setup();
  renderCreate();

  const save = screen.getByRole('button', { name: /Create rule/i }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);

  await user.type(screen.getByLabelText('Name'), 'Rule name');
  expect(save.disabled).toBe(true);

  await user.selectOptions(screen.getByLabelText('When a scan with status'), 'in_transit');
  expect(save.disabled).toBe(true);

  await user.selectOptions(screen.getByLabelText('matches a'), 'fuzzy');
  expect(save.disabled).toBe(true); // still no actions

  await user.click(screen.getByRole('button', { name: 'Add action' }));
  expect(save.disabled).toBe(false);
});

it('condition row: selecting operator "is_null" hides the value control', async () => {
  const user = userEvent.setup();
  renderCreate();

  await user.click(screen.getByRole('button', { name: 'Add condition' }));
  expect(screen.getByLabelText('Condition 1 value')).not.toBeNull();

  await user.selectOptions(screen.getByLabelText('Condition 1 operator'), 'is_null');
  expect(screen.queryByLabelText('Condition 1 value')).toBeNull();
});

it('edit mode: prefills fields from the rule prop and submits updateStatusRule(rule.id, …)', async () => {
  const user = userEvent.setup();
  api.updateStatusRule.mockResolvedValue(RULE);
  const { onSaved } = renderEdit();

  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Existing rule');
  expect((screen.getByLabelText('When a scan with status') as HTMLSelectElement).value)
    .toBe('delivered');
  expect((screen.getByLabelText('matches a') as HTMLSelectElement).value).toBe('exact');
  expect((screen.getByLabelText('Condition 1 value') as HTMLSelectElement).value).toBe('bad');
  expect((screen.getByLabelText('Action 1 status') as HTMLSelectElement).value).toBe('good');

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

it('shows the detail-code error text when the api call rejects', async () => {
  const user = userEvent.setup();
  api.updateStatusRule.mockRejectedValue(new ApiError(422, 'bad_action'));
  renderEdit();

  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('One of the actions is invalid.')).not.toBeNull();
});
