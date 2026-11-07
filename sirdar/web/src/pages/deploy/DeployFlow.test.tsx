// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'view' || (a === 'add' && perms.add) || (a === 'change' && perms.change)),
  }),
}));

const api = vi.hoisted(() => ({
  getDeployTargets: vi.fn(), getEnvironmentDefaults: vi.fn(), getIntegrations: vi.fn(), getDoAccounts: vi.fn(),
  listSnapshots: vi.fn(), listKnownHosts: vi.fn(), createEnvironment: vi.fn(), startDeployment: vi.fn(),
  trustKnownHost: vi.fn(), getDoRegions: vi.fn(), connectDeploy: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));
const seed = vi.hoisted(() => ({
  listRecipes: vi.fn(), getRecipe: vi.fn(), openSnapshot: vi.fn(), snapshotStatus: vi.fn(), resolveSelection: vi.fn(),
  buildRecipe: vi.fn(),
}));
vi.mock('../seed/seedApi', async (orig) => ({ ...(await orig<typeof import('../seed/seedApi')>()), ...seed }));

import { ApiError } from '@portal/lib/api';

import { snapshotLabel } from '../environments/labels';
import { DO_ACCOUNTS_BOTH, ENV, RUNNING, SNAP } from '../environments/testData';

import DeployFlow from './DeployFlow';
import { FLOW_DEFAULTS, FLOW_INTEGRATIONS, FLOW_TARGETS } from './flowFixtures';

beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getDeployTargets.mockResolvedValue({ targets: FLOW_TARGETS, types: [] });
  api.getEnvironmentDefaults.mockResolvedValue(FLOW_DEFAULTS);
  api.getIntegrations.mockResolvedValue(FLOW_INTEGRATIONS);
  api.getDoAccounts.mockResolvedValue({ accounts: DO_ACCOUNTS_BOTH });
  api.listSnapshots.mockResolvedValue({ snapshots: [SNAP] });
  api.listKnownHosts.mockResolvedValue([]);
  Object.values(seed).forEach((f) => f.mockReset());
  seed.listRecipes.mockResolvedValue([RECIPE]);
  seed.getRecipe.mockResolvedValue({ id: 'r1', name: 'Acme only', notes: '', files: {},
                                     tables: { people: { mode: 'rows', pks: [{ id: '1' }] } } });
  seed.openSnapshot.mockResolvedValue({ status: 'ready' });
  seed.resolveSelection.mockResolvedValue({ added: {}, reasons: [], added_tables: [], missing_tables: [], missing: {} });
});
const RECIPE = { id: 'r1', name: 'Acme only', notes: '', tables: 1, rows: 1, files: 0, updated_at: '2026-11-07T10:00:00Z' };
Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
afterEach(cleanup);

function Where() { const l = useLocation(); return <p>at {l.pathname}{l.search}</p>; }
async function open() {
  render(<MemoryRouter initialEntries={['/deploy']}>
    <Routes>
      <Route path="/deploy" element={<DeployFlow targets={FLOW_TARGETS} reloadTargets={vi.fn()} />} />
      <Route path="/deploy/environments/:name" element={<Where />} />
    </Routes>
  </MemoryRouter>);
  await screen.findByLabelText('Name');
}
const next = () => userEvent.click(screen.getByRole('button', { name: 'Next' }));

async function sshToReview() {
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await userEvent.click(screen.getByRole('radio', { name: 'Custom' }));
  await next();                                              // Servers
  await next();                                              // Target
  await userEvent.click(screen.getByRole('radio', { name: /Lab box/ }));
  await next();                                              // Extras
  await next();                                              // Traffic
  await next();                                              // Data
  await userEvent.type(screen.getByLabelText('First name'), 'Ada');
  await userEvent.type(screen.getByLabelText('Last name'), 'Lovelace');
  await userEvent.type(screen.getByLabelText('Email'), 'ada@test.example.com');
  await userEvent.type(screen.getByLabelText('Password'), 'Correct-Horse-9');
  await userEvent.type(screen.getByLabelText('Type it again'), 'Correct-Horse-9');
  await next();                                              // Review
}

it('shows Loading until the defaults, targets and integrations answer', async () => {
  api.getEnvironmentDefaults.mockReturnValue(new Promise(() => {}));
  render(<MemoryRouter><DeployFlow targets={FLOW_TARGETS} reloadTargets={vi.fn()} /></MemoryRouter>);
  expect(screen.getByText('Loading…')).toBeTruthy();
});

it('a defaults load failure is shown', async () => {
  api.getEnvironmentDefaults.mockRejectedValue(new ApiError(500, 'boom', { code: 'boom' }));
  render(<MemoryRouter><DeployFlow targets={FLOW_TARGETS} reloadTargets={vi.fn()} /></MemoryRouter>);
  expect((await screen.findByRole('alert')).textContent).toBeTruthy();
  expect(screen.queryByText('Loading…')).toBeNull();
});

it('has the report-generate header and the seven steps', async () => {
  await open();
  expect(screen.getByText('Deploy', { selector: '.eyebrow' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Environment' })).toBeTruthy();
  for (const label of ['Environment', 'Servers', 'Target', 'Extras', 'Traffic', 'Data', 'Review & Deploy'])
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  expect(document.querySelector('.rgm-steps .rgm-step.on .rgm-step-label')?.textContent).toBe('Environment');
  expect(document.querySelector('.rgm-head-text .page-hint')?.textContent).toBe('A new environment: its type and name.');
  expect(document.querySelector('select')).toBeNull();
});

it('checks each step before Next and keeps choices on Back', async () => {
  await open();
  await next();
  expect(screen.getByText('Enter a name.')).toBeTruthy();
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await next();
  expect(screen.getByRole('heading', { name: 'Servers' })).toBeTruthy();
  expect(document.querySelector('.rgm-step.done .rgm-step-label')?.textContent).toBe('Environment');
  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('qa');
});

it('the Target step has Connect and Trusted SSH hosts as h3 under the step title (h2)', async () => {
  await open();
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await next(); await next();
  expect(screen.getByRole('heading', { name: 'Target', level: 2 })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Connect', level: 3 })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Trusted SSH hosts', level: 3 })).toBeTruthy();
});

it('Start over asks first, then clears every choice', async () => {
  const confirm = vi.spyOn(window, 'confirm');
  await open();
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await next();
  confirm.mockReturnValueOnce(false);
  await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
  expect(screen.getByRole('heading', { name: 'Servers' })).toBeTruthy();
  confirm.mockReturnValueOnce(true);
  await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
  expect(screen.getByRole('heading', { name: 'Environment' })).toBeTruthy();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
  confirm.mockRestore();
});

it('creates and deploys an SSH environment end to end', async () => {
  api.createEnvironment.mockResolvedValue({ ...ENV, name: 'qa' });
  api.startDeployment.mockResolvedValue({ ...RUNNING, id: 'dep-1', environment: 'qa' });
  await open();
  await sshToReview();
  expect(screen.getByRole('heading', { name: 'Review & Deploy' })).toBeTruthy();
  expect(screen.queryByText('Correct-Horse-9')).toBeNull();               // never shown
  expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  await screen.findByText('at /deploy/environments/qa?deployment=dep-1');
  expect(api.createEnvironment).toHaveBeenCalledWith(expect.objectContaining({
    name: 'qa', type: 'custom', target: 'ssh:lab', proxy_ip: '10.10.48.6',
    first_admin: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@test.example.com', password_mode: 'typed',
                   password: 'Correct-Horse-9' } }));
  expect(api.startDeployment).toHaveBeenCalledWith('qa', { mode: 'update', seed_content: true });
});

it('an API error goes back to its step', async () => {
  api.createEnvironment.mockRejectedValue(new ApiError(422, 'proxy_ip_invalid', { code: 'proxy_ip_invalid' }));
  await open();
  await sshToReview();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  expect(await screen.findByRole('heading', { name: 'Target' })).toBeTruthy();
  expect(screen.getByText('The proxy IP must be an IPv4 address.')).toBeTruthy();
});

it('an error no step owns stays on Review', async () => {
  api.createEnvironment.mockRejectedValue(new ApiError(500, 'internal', { code: 'internal' }));
  await open();
  await sshToReview();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Review & Deploy' })).toBeTruthy();
  expect(api.startDeployment).not.toHaveBeenCalled();
});

it('an Environment-step error focuses the name', async () => {
  api.createEnvironment.mockRejectedValue(new ApiError(409, 'environment_exists', { code: 'environment_exists' }));
  await open();
  await sshToReview();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  await screen.findByText('An environment with that name already exists.');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
});

it('an unknown host key on the first deployment is trusted, then the deploy is retried', async () => {
  api.createEnvironment.mockResolvedValue({ ...ENV, name: 'qa' });
  api.startDeployment
    .mockRejectedValueOnce(new ApiError(409, 'host_key_unknown', { code: 'host_key_unknown', host: '10.10.48.70', port: 22,
                                                                   key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc' }))
    .mockResolvedValueOnce({ ...RUNNING, id: 'dep-2', environment: 'qa' });
  api.trustKnownHost.mockResolvedValue({});
  await open();
  await sshToReview();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Trust and deploy' }));
  await screen.findByText('at /deploy/environments/qa?deployment=dep-2');
  expect(api.createEnvironment).toHaveBeenCalledTimes(1);                   // created once
  expect(api.trustKnownHost).toHaveBeenCalledWith('10.10.48.70', 22, 'SHA256:abc', 'ssh:lab');
});

it('a start that fails after the create says so, and Deploy only retries the start', async () => {
  api.createEnvironment.mockResolvedValue({ ...ENV, name: 'qa' });
  api.startDeployment.mockRejectedValueOnce(new ApiError(409, 'deploy_in_progress', { code: 'deploy_in_progress' }))
    .mockResolvedValueOnce({ ...RUNNING, id: 'dep-3', environment: 'qa' });
  await open();
  await sshToReview();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  const alert = await screen.findByText(/Created qa, but its first deployment didn't start/);
  expect(within(alert).getByRole('link', { name: 'Open the environment' }).getAttribute('href')).toBe('/deploy/environments/qa');
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  await screen.findByText('at /deploy/environments/qa?deployment=dep-3');
  expect(api.createEnvironment).toHaveBeenCalledTimes(1);
});

it('a double click on Deploy creates once', async () => {
  let resolve: (v: unknown) => void = () => {};
  api.createEnvironment.mockReturnValue(new Promise((r) => { resolve = r; }));
  api.startDeployment.mockResolvedValue({ ...RUNNING, id: 'dep-4', environment: 'qa' });
  await open();
  await sshToReview();
  const btn = screen.getByRole('button', { name: 'Deploy' });
  await userEvent.dblClick(btn);
  resolve({ ...ENV, name: 'qa' });
  await screen.findByText('at /deploy/environments/qa?deployment=dep-4');
  expect(api.createEnvironment).toHaveBeenCalledTimes(1);
});

it('a gone snapshot sends you back to Data and is no longer offered', async () => {
  api.createEnvironment.mockRejectedValue(new ApiError(409, 'snapshot_not_ready', { code: 'snapshot_not_ready' }));
  await open();
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await next(); await next();
  await userEvent.click(screen.getByRole('radio', { name: /Lab box/ }));
  await next(); await next(); await next();
  await userEvent.click(screen.getByRole('radio', { name: 'From a snapshot' }));
  await userEvent.click(screen.getByLabelText('Snapshot'));
  await userEvent.click(await screen.findByText(snapshotLabel(SNAP)));
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  expect(await screen.findByRole('heading', { name: 'Data' })).toBeTruthy();
  expect(screen.getByRole('radio', { name: 'From a snapshot' }).getAttribute('aria-disabled')).toBe('true');
});

it('only ready snapshots are offered', async () => {
  api.listSnapshots.mockResolvedValue({ snapshots: [{ ...SNAP, status: 'taking' }] });
  await open();
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await next(); await next();
  await userEvent.click(screen.getByRole('radio', { name: /Lab box/ }));
  await next(); await next(); await next();
  expect(screen.getByRole('radio', { name: 'From a snapshot' }).getAttribute('aria-disabled')).toBe('true');
});

it('without deploy:add renders nothing', async () => {
  perms.add = false;
  const { container } = render(<MemoryRouter><DeployFlow targets={FLOW_TARGETS} reloadTargets={vi.fn()} /></MemoryRouter>);
  await waitFor(() => expect(api.getEnvironmentDefaults).toHaveBeenCalled());
  expect(container.textContent).toBe('');
});

it('Next and Back move focus to the step title and announce the step', async () => {
  await open();
  const live = () => document.querySelector('[aria-live="polite"]')?.textContent;
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await next();
  const title = screen.getByRole('heading', { name: 'Servers', level: 2 });
  await waitFor(() => expect(document.activeElement).toBe(title));
  expect(live()).toBe('Step 2 of 7: Servers');
  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Environment', level: 2 })));
  expect(live()).toBe('Step 1 of 7: Environment');
});

it('once created, the flow is locked on Review: no Back, no steps, the choices stay put', async () => {
  api.createEnvironment.mockResolvedValue({ ...ENV, name: 'qa' });
  api.startDeployment.mockRejectedValueOnce(new ApiError(409, 'deploy_in_progress', { code: 'deploy_in_progress' }));
  await open();
  await sshToReview();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  await screen.findByText(/Created qa, but its first deployment didn't start/);
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  expect(document.querySelector('.rgm-steps')).toBeNull();
  expect(screen.getByRole('button', { name: 'Deploy' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Start over' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open the environment' })).toBeTruthy();
  expect(document.querySelector('.sirdar-flow input')).toBeNull();
});

it('Start over after a create starts a new environment', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.createEnvironment.mockResolvedValue({ ...ENV, name: 'qa' });
  api.startDeployment.mockRejectedValueOnce(new ApiError(409, 'deploy_in_progress', { code: 'deploy_in_progress' }));
  await open();
  await sshToReview();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  await screen.findByText(/Created qa, but its first deployment didn't start/);
  await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
  expect(screen.getByRole('heading', { name: 'Environment' })).toBeTruthy();
  expect(document.querySelector('.rgm-steps')).toBeTruthy();
  confirm.mockRestore();
});

it('a lost create response, then environment_exists for that name, offers to open it', async () => {
  api.createEnvironment.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockRejectedValueOnce(new ApiError(409, 'environment_exists', { code: 'environment_exists' }));
  await open();
  await sshToReview();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('heading', { name: 'Review & Deploy' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  await screen.findByText('An environment with that name already exists.');
  expect(screen.getByText(/It may have been created already/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'open it' }).getAttribute('href')).toBe('/deploy/environments/qa');
});

it('environment_exists on a first try is only the Name error', async () => {
  api.createEnvironment.mockRejectedValue(new ApiError(409, 'environment_exists', { code: 'environment_exists' }));
  await open();
  await sshToReview();
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  await screen.findByText('An environment with that name already exists.');
  expect(screen.queryByText(/It may have been created already/)).toBeNull();
});

const BUILT = { ...SNAP, id: 'b1', name: 'Acme only from dev-2026-10-04', origin: 'recipe' as 'upload', status: 'pending' as const };

async function recipeToReview(reset: boolean) {
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await userEvent.click(screen.getByRole('radio', { name: 'Custom' }));
  await next(); await next();
  await userEvent.click(screen.getByRole('radio', { name: /Lab box/ }));
  await next(); await next(); await next();                  // Data
  await userEvent.click(screen.getByRole('radio', { name: 'From a recipe' }));
  await userEvent.click(screen.getByLabelText('Recipe'));
  await userEvent.click(await screen.findByText('Acme only'));
  await userEvent.click(screen.getByLabelText('Snapshot'));
  await userEvent.click(await screen.findByText(snapshotLabel(SNAP)));
  await screen.findByText('1 of 1 ticked records found in this snapshot; 0 missing');
  if (reset) {
    await userEvent.click(screen.getByRole('radio', { name: 'Make everyone reset their password' }));
    await next();
    expect(screen.getByRole('heading', { name: 'Data' })).toBeTruthy();      // the first admin is required
    await userEvent.type(screen.getByLabelText('First name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Last name'), 'Lovelace');
    await userEvent.type(screen.getByLabelText('Email'), 'ada@test.example.com');
    await userEvent.click(screen.getByRole('radio', { name: 'Generate & invite' }));
  }
  await next();                                              // Review
  expect(screen.getByRole('heading', { name: 'Review & Deploy' })).toBeTruthy();
}

it('From a recipe builds the snapshot, waits for it, then creates with it and the first admin', async () => {
  seed.buildRecipe.mockResolvedValue(BUILT);
  api.createEnvironment.mockResolvedValue({ ...ENV, name: 'qa' });
  api.startDeployment.mockResolvedValue({ ...RUNNING, id: 'dep-1', environment: 'qa' });
  await open();
  await recipeToReview(true);
  api.listSnapshots.mockResolvedValue({ snapshots: [SNAP, { ...BUILT, status: 'ready' }] });
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Building the recipe's snapshot…")).toBeTruthy();
    expect(seed.buildRecipe).toHaveBeenCalledWith('r1', { snapshot_id: SNAP.id, reset_passwords: true });
    expect(api.createEnvironment).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  } finally { vi.useRealTimers(); }
  await screen.findByText('at /deploy/environments/qa?deployment=dep-1');
  expect(api.createEnvironment).toHaveBeenCalledWith(expect.objectContaining({
    snapshot_id: 'b1',
    first_admin: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@test.example.com', password_mode: 'invite',
                   password: null } }));
  expect(api.startDeployment).toHaveBeenCalledWith('qa', { mode: 'update' });
});

it('keeping passwords with no first admin sends none', async () => {
  seed.buildRecipe.mockResolvedValue({ ...BUILT, status: 'ready' });
  api.createEnvironment.mockResolvedValue({ ...ENV, name: 'qa' });
  api.startDeployment.mockResolvedValue({ ...RUNNING, id: 'dep-1', environment: 'qa' });
  await open();
  await recipeToReview(false);
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  await screen.findByText('at /deploy/environments/qa?deployment=dep-1');
  expect(seed.buildRecipe).toHaveBeenCalledWith('r1', { snapshot_id: SNAP.id, reset_passwords: false });
  const body = api.createEnvironment.mock.calls[0][0];
  expect(body.snapshot_id).toBe('b1');
  expect(body.first_admin).toBeUndefined();
});

it("a failed build shows the snapshot's notes on the Data step and creates nothing", async () => {
  seed.buildRecipe.mockResolvedValue(BUILT);
  await open();
  await recipeToReview(false);
  api.listSnapshots.mockResolvedValue({ snapshots: [SNAP, { ...BUILT, status: 'failed', notes: 'reset_failed' }] });
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  } finally { vi.useRealTimers(); }
  expect(await screen.findByRole('heading', { name: 'Data' })).toBeTruthy();
  expect(screen.getByText("The password reset couldn't be applied.")).toBeTruthy();
  expect(api.createEnvironment).not.toHaveBeenCalled();
});

it('a failed build with an unknown code shows the code', async () => {
  seed.buildRecipe.mockResolvedValue({ ...BUILT, status: 'failed', notes: 'something_new: detail' });
  await open();
  await recipeToReview(false);
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  expect(await screen.findByText('something_new: detail')).toBeTruthy();
});
