// @vitest-environment jsdom
/**
 * /learning/rules — ordered rule rows ("When <field> is <values> → packet",
 * an On/Off chip, an actions menu), reorder by drag or Move up/down posting
 * the full id order, New/Edit rule, turn on/off, delete, and the dry-run
 * panel underneath. Every control follows the API's learning action.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { LearningRule } from '../../lib/learning';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

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
  listLearningRules: vi.fn(),
  reorderLearningRules: vi.fn(),
  patchLearningRule: vi.fn(),
  deleteLearningRule: vi.fn(),
  createLearningRule: vi.fn(),
  listLearningPackets: vi.fn(),
}));
vi.mock('../../lib/learning', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/learning')>()),
  ...api,
}));
const apiLib = vi.hoisted(() => ({
  listClients: vi.fn(),
  listPartners: vi.fn(),
  listSites: vi.fn(),
  listInitiatives: vi.fn(),
  listInitiativeWorkTypes: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...apiLib,
}));
vi.mock('../../components/learning/DryRunPanel', () => ({ default: () => <div>Dry run panel</div> }));

const { default: LearningRules } = await import('./LearningRules');

const rule = (id: string, name: string, over: Partial<LearningRule> = {}): LearningRule => ({
  id, name, packet_id: 'pk1', packet_name: 'Standard onboarding', packet_archived: false,
  conditions: [{ field: 'everyone', values: [] }], position: 1, enabled: true,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...over,
});

const R1 = rule('r1', 'Everyone');
const R2 = rule('r2', 'Acme', {
  packet_id: 'pk2', packet_name: 'Acme site rules',
  conditions: [{ field: 'client', values: ['c1'] }, { field: 'site_country', values: ['SINGAPORE'] }],
});
const R3 = rule('r3', 'Forklifts', {
  packet_name: 'Forklift safety', enabled: false,
  conditions: [{ field: 'worker_role', values: ['forklift'] }],
});

function renderPage() {
  return render(<MemoryRouter><LearningRules /></MemoryRouter>);
}

const rowNames = () => Array.from(document.querySelectorAll('.lrn-rule-name')).map((e) => e.textContent);
const rowOf = (name: string) => screen.getByText(name, { selector: '.lrn-rule-name' }).closest('.dir-row') as HTMLElement;

async function menu(name: string, item: string) {
  const user = userEvent.setup();
  await user.click(within(rowOf(name)).getByRole('button', { name: /actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}

beforeEach(() => {
  auth.perms = { view: true, add: true, change: true, delete: true };
  api.listLearningRules.mockReset().mockResolvedValue([R1, R2, R3]);
  api.reorderLearningRules.mockReset().mockImplementation(async (ids: string[]) =>
    ids.map((id) => [R1, R2, R3].find((r) => r.id === id)!));
  api.patchLearningRule.mockReset().mockImplementation(async (id: string, b: object) =>
    ({ ...[R1, R2, R3].find((r) => r.id === id)!, ...b }));
  api.deleteLearningRule.mockReset().mockResolvedValue(undefined);
  api.listLearningPackets.mockReset().mockResolvedValue([]);
  apiLib.listClients.mockReset().mockResolvedValue([{ id: 'c1', name: 'Acme Corp' }]);
  apiLib.listPartners.mockReset().mockResolvedValue([]);
  apiLib.listSites.mockReset().mockResolvedValue([]);
  apiLib.listInitiatives.mockReset().mockResolvedValue([]);
  apiLib.listInitiativeWorkTypes.mockReset().mockResolvedValue([
    { key: 'forklift', label: 'Forklift operator', is_active: true },
  ]);
  toast.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('lists the rules in order with their conditions, packet and On/Off chip', async () => {
  renderPage();
  await screen.findByText('Acme', { selector: '.lrn-rule-name' });
  expect(rowNames()).toEqual(['Everyone', 'Acme', 'Forklifts']);

  const everyone = rowOf('Everyone');
  expect(within(everyone).getByText('Standard onboarding')).toBeTruthy();
  expect(within(everyone).getByText('On').className).toContain('c-green');

  // names, not ids: "When Client is Acme Corp and Site country is SINGAPORE → Acme site rules"
  const acme = rowOf('Acme');
  await waitFor(() => expect(within(acme).getByText('Acme Corp')).toBeTruthy());
  expect(within(acme).getByText('Client').className).toContain('lrn-tok');
  expect(within(acme).getByText('SINGAPORE')).toBeTruthy();
  expect(within(acme).getByText('Acme site rules')).toBeTruthy();

  const forklifts = rowOf('Forklifts');
  await waitFor(() => expect(within(forklifts).getByText('Forklift operator')).toBeTruthy());
  expect(within(forklifts).getByText('Off').className).not.toContain('c-green');
  expect(screen.getByText('Dry run panel')).toBeTruthy();
});

it('only loads the lookups the rules need', async () => {
  renderPage();
  await screen.findByText('Acme', { selector: '.lrn-rule-name' });
  await waitFor(() => expect(apiLib.listClients).toHaveBeenCalled());
  expect(apiLib.listInitiativeWorkTypes).toHaveBeenCalled();
  expect(apiLib.listPartners).not.toHaveBeenCalled();
  expect(apiLib.listInitiatives).not.toHaveBeenCalled();
});

it('Move down posts the full order and shows the server order', async () => {
  renderPage();
  await screen.findByText('Acme', { selector: '.lrn-rule-name' });
  await menu('Everyone', 'Move down');
  await waitFor(() => expect(api.reorderLearningRules).toHaveBeenCalledWith(['r2', 'r1', 'r3']));
  await waitFor(() => expect(rowNames()).toEqual(['Acme', 'Everyone', 'Forklifts']));
});

it('the first rule cannot move up and the last cannot move down', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Acme', { selector: '.lrn-rule-name' });
  await user.click(within(rowOf('Everyone')).getByRole('button', { name: /actions/i }));
  expect((await screen.findByRole('menuitem', { name: 'Move up' })).hasAttribute('disabled')).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  await user.click(within(rowOf('Forklifts')).getByRole('button', { name: /actions/i }));
  expect((await screen.findByRole('menuitem', { name: 'Move down' })).hasAttribute('disabled')).toBe(true);
});

it('dragging a rule posts the full order', async () => {
  renderPage();
  await screen.findByText('Acme', { selector: '.lrn-rule-name' });
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
  fireEvent.dragStart(rowOf('Forklifts'), { dataTransfer });
  fireEvent.dragOver(rowOf('Everyone'), { dataTransfer, clientY: 0 });
  fireEvent.drop(rowOf('Everyone'), { dataTransfer });
  await waitFor(() => expect(api.reorderLearningRules).toHaveBeenCalledWith(['r1', 'r3', 'r2']));
});

it('a failed reorder puts the list back and says so', async () => {
  api.reorderLearningRules.mockRejectedValueOnce(new ApiError(500, 'boom'));
  renderPage();
  await screen.findByText('Acme', { selector: '.lrn-rule-name' });
  await menu('Everyone', 'Move down');
  expect(await screen.findByText(/couldn.t save the new order/i)).toBeTruthy();
  await waitFor(() => expect(rowNames()).toEqual(['Everyone', 'Acme', 'Forklifts']));
});

it('turns a rule on or off with a patch of enabled only', async () => {
  renderPage();
  await screen.findByText('Acme', { selector: '.lrn-rule-name' });
  await menu('Forklifts', 'Turn on');
  await waitFor(() => expect(api.patchLearningRule).toHaveBeenCalledWith('r3', { enabled: true }));
  await waitFor(() => expect(within(rowOf('Forklifts')).getByText('On')).toBeTruthy());
  await menu('Everyone', 'Turn off');
  await waitFor(() => expect(api.patchLearningRule).toHaveBeenCalledWith('r1', { enabled: false }));
});

it('deletes a rule after asking', async () => {
  renderPage();
  await screen.findByText('Acme', { selector: '.lrn-rule-name' });
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  await menu('Acme', 'Delete');
  expect(api.deleteLearningRule).not.toHaveBeenCalled();
  await menu('Acme', 'Delete');
  await waitFor(() => expect(api.deleteLearningRule).toHaveBeenCalledWith('r2'));
  await waitFor(() => expect(rowNames()).toEqual(['Everyone', 'Forklifts']));
});

it('New rule and Edit open the rule editor', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Acme', { selector: '.lrn-rule-name' });
  await user.click(screen.getByRole('button', { name: 'New rule' }));
  expect(await screen.findByRole('dialog', { name: /new assignment rule/i })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Close' }));
  await menu('Acme', 'Edit');
  const dialog = await screen.findByRole('dialog', { name: /edit assignment rule/i });
  expect((within(dialog).getByLabelText('Rule name') as HTMLInputElement).value).toBe('Acme');
});

it('flags a rule whose packet was archived', async () => {
  api.listLearningRules.mockResolvedValue([rule('r1', 'Old', { packet_archived: true })]);
  renderPage();
  await screen.findByText('Old', { selector: '.lrn-rule-name' });
  expect(within(rowOf('Old')).getByText('Packet archived')).toBeTruthy();
});

it('view-only managers see the rules and no controls', async () => {
  auth.perms = { view: true };
  renderPage();
  await screen.findByText('Acme', { selector: '.lrn-rule-name' });
  expect(screen.queryByRole('button', { name: 'New rule' })).toBeNull();
  expect(screen.queryByRole('button', { name: /actions/i })).toBeNull();
  expect(document.querySelector('[draggable="true"]')).toBeNull();
});

it('gates each menu item on its own action', async () => {
  auth.perms = { view: true, delete: true };
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Acme', { selector: '.lrn-rule-name' });
  await user.click(within(rowOf('Acme')).getByRole('button', { name: /actions/i }));
  expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Move down' })).toBeNull();
});

it('shows an empty state and a load failure with retry', async () => {
  api.listLearningRules.mockResolvedValueOnce([]);
  const first = renderPage();
  expect(await screen.findByText(/no rules yet/i)).toBeTruthy();
  first.unmount();

  api.listLearningRules.mockRejectedValueOnce(new ApiError(500, 'boom'));
  renderPage();
  expect(await screen.findByText(/couldn.t load the rules/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Acme', { selector: '.lrn-rule-name' })).toBeTruthy();
});
