// @vitest-environment jsdom
/**
 * HealthTab — Developer › Database › Health. The five health calls are
 * mocked per the contract in docs/superpowers/specs/2026-10-09-db-health-
 * design.md. The open RowActionsMenu is portaled to document.body, so menu
 * items are queried via `screen`, never `within(row)`.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, type HealthConnectionGroup, type HealthStorageOut, type HealthSummary,
  type HealthTable,
} from '../../lib/api';
import { LIST_FIT } from '../../lib/listTools';
import HealthTab from './HealthTab';

const auth = vi.hoisted(() => ({ canChange: true }));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ can: () => auth.canChange, preferences: { list_size: 'medium' } }),
}));

const api = vi.hoisted(() => ({
  getHealthSummary: vi.fn(),
  getHealthConnections: vi.fn(),
  getHealthTables: vi.fn(),
  vacuumHealthTable: vi.fn(),
  getHealthStorage: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const GB = 1024 ** 3;

function summary(over: Partial<HealthSummary> = {}): HealthSummary {
  return {
    database_size_bytes: 1.2 * GB,
    version: '16.4',
    started_at: new Date(Date.now() - (3 * 86400 + 4 * 3600 + 120) * 1000).toISOString(),
    latency_ms: 4.2,
    connections: 23,
    max_connections: 100,
    cache_hit_ratio: 0.991,
    ...over,
  };
}

function group(over: Partial<HealthConnectionGroup> = {}): HealthConnectionGroup {
  return {
    application_name: 'serversherpa-api', state: 'idle', count: 4,
    oldest_query_seconds: 2, oldest_transaction_seconds: null, waiting_on_lock: 0, ...over,
  };
}

function table(name: string, over: Partial<HealthTable> = {}): HealthTable {
  return {
    name, rows: 10, total_bytes: 1024 * 1024, table_bytes: 512 * 1024, index_bytes: 512 * 1024,
    dead_rows: 0, dead_ratio: 0, last_vacuum_at: null, last_analyze_at: null, ...over,
  };
}

const storage = (): HealthStorageOut => ({
  folders: [
    { name: 'attachments', objects: 1200, bytes: 2 * GB },
    { name: '(root)', objects: 3, bytes: 4096 },
  ],
  total_objects: 1203,
  total_bytes: 2 * GB + 4096,
  measured_at: '2026-10-09T15:30:00Z',
});

beforeEach(() => {
  auth.canChange = true;
  api.getHealthSummary.mockReset().mockResolvedValue(summary());
  api.getHealthConnections.mockReset().mockResolvedValue({ groups: [] });
  api.getHealthTables.mockReset().mockResolvedValue({ tables: [] });
  api.vacuumHealthTable.mockReset();
  api.getHealthStorage.mockReset();
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const tile = (label: string) =>
  screen.getByText(label, { selector: '.health-tile-label' }).closest('.health-tile') as HTMLElement;

/** Table names in on-screen order. */
const tableOrder = () =>
  Array.from(document.querySelectorAll('[aria-label="Tables"] .dir-row .cell-top'))
    .map((el) => el.textContent);

async function renderTab() {
  const user = userEvent.setup();
  render(<HealthTab />);
  await waitFor(() => expect(api.getHealthTables).toHaveBeenCalled());
  return user;
}

it('renders the summary tiles with formatted values', async () => {
  await renderTab();
  await waitFor(() => expect(within(tile('Database size')).getByText('1.2 GB')).not.toBeNull());
  expect(within(tile('Postgres version')).getByText('16.4')).not.toBeNull();
  expect(within(tile('Uptime')).getByText('3 d 4 h')).not.toBeNull();
  expect(within(tile('Response time')).getByText('4 ms')).not.toBeNull();
  expect(within(tile('Connections')).getByText('23 of 100')).not.toBeNull();
  expect(within(tile('Cache hit rate')).getByText('99.1%')).not.toBeNull();
});

it('says the Connections tile counts the whole database server', async () => {
  await renderTab();
  await waitFor(() => expect(within(tile('Connections')).getByText('23 of 100')).not.toBeNull());
  expect(within(tile('Connections')).getByText(/across the whole database server/i)).not.toBeNull();
});

it('shows a dash for a missing cache hit rate', async () => {
  api.getHealthSummary.mockResolvedValue(summary({ cache_hit_ratio: null }));
  await renderTab();
  await waitFor(() => expect(within(tile('Database size')).getByText('1.2 GB')).not.toBeNull());
  expect(within(tile('Cache hit rate')).getByText('—')).not.toBeNull();
});

it('keeps the rest of the page when the summary fails', async () => {
  api.getHealthSummary.mockRejectedValue(new ApiError(500, 'boom'));
  api.getHealthTables.mockResolvedValue({ tables: [table('asset')] });
  await renderTab();
  expect(await screen.findByText('Could not load the summary — try again.')).not.toBeNull();
  expect(await screen.findByText('asset')).not.toBeNull();
});

it('Refresh reloads summary, connections and tables, and nothing polls', async () => {
  const user = await renderTab();
  await waitFor(() => expect(api.getHealthSummary).toHaveBeenCalledTimes(1));
  expect(api.getHealthConnections).toHaveBeenCalledTimes(1);
  expect(api.getHealthTables).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole('button', { name: 'Refresh' }));

  await waitFor(() => expect(api.getHealthSummary).toHaveBeenCalledTimes(2));
  expect(api.getHealthConnections).toHaveBeenCalledTimes(2);
  expect(api.getHealthTables).toHaveBeenCalledTimes(2);
  expect(api.getHealthStorage).not.toHaveBeenCalled();
});

it('lists connection groups, flags old ones, and counts lock waiters', async () => {
  api.getHealthConnections.mockResolvedValue({ groups: [
    group({ application_name: 'serversherpa-api', count: 4 }),
    group({ application_name: 'Other', state: 'idle in transaction', count: 1,
      oldest_query_seconds: 400, oldest_transaction_seconds: 372, waiting_on_lock: 2 }),
  ] });
  await renderTab();
  const card = await screen.findByRole('region', { name: 'Connections' });
  const rows = await within(card).findAllByText(/^(serversherpa-api|Other)$/);
  expect(rows).toHaveLength(2);

  const other = rows[1].closest('.dir-row') as HTMLElement;
  expect(within(other).getByText('idle in transaction')).not.toBeNull();
  expect(within(other).getByText('2 waiting on a lock')).not.toBeNull();
  // 400 s query and 372 s transaction are both over five minutes
  const q = within(other).getByText('6 m 40 s');
  const t = within(other).getByText('6 m 12 s');
  expect(q.className).toMatch(/c-amber/);
  expect(t.className).toMatch(/c-amber/);

  const calm = rows[0].closest('.dir-row') as HTMLElement;
  const age = within(calm).getByText('2 s');
  expect(age.className).not.toMatch(/c-amber/);
  expect(within(calm).queryByText(/waiting on a lock/)).toBeNull();
  expect(within(card).getByText(/this database only/i)).not.toBeNull();
});

it('says so when there are no other connections', async () => {
  await renderTab();
  expect(await screen.findByText('No other connections right now.')).not.toBeNull();
});

it('tables default to total size, largest first', async () => {
  api.getHealthTables.mockResolvedValue({ tables: [
    table('small', { total_bytes: 100 }),
    table('big', { total_bytes: 9000 }),
    table('mid', { total_bytes: 500 }),
  ] });
  await renderTab();
  await screen.findByText('big');
  expect(tableOrder()).toEqual(['big', 'mid', 'small']);
  const head = document.querySelector('[aria-label="Tables"] .list-head') as HTMLElement;
  expect(within(head).getByRole('button', { name: /Total/ }).textContent).toMatch(/▼/);
});

it('clicking a header sorts by that column, and again reverses it', async () => {
  api.getHealthTables.mockResolvedValue({ tables: [
    table('rack 10', { rows: 5, total_bytes: 300 }),
    table('rack 2', { rows: 50, total_bytes: 200 }),
    table('asset', { rows: 7, total_bytes: 100 }),
  ] });
  const user = await renderTab();
  await screen.findByText('asset');
  const head = document.querySelector('[aria-label="Tables"] .list-head') as HTMLElement;

  await user.click(within(head).getByRole('button', { name: /^Name/ }));
  expect(tableOrder()).toEqual(['asset', 'rack 2', 'rack 10']);
  await user.click(within(head).getByRole('button', { name: /^Name/ }));
  expect(tableOrder()).toEqual(['rack 10', 'rack 2', 'asset']);

  await user.click(within(head).getByRole('button', { name: /^Rows/ }));
  expect(tableOrder()).toEqual(['rack 2', 'asset', 'rack 10']);
});

it('shows sizes, dead rows with their share, and vacuum/analyze times', async () => {
  api.getHealthTables.mockResolvedValue({ tables: [
    table('asset', {
      rows: 12345, total_bytes: 3 * 1024 * 1024, table_bytes: 1024 * 1024,
      index_bytes: 2 * 1024 * 1024, dead_rows: 1204, dead_ratio: 0.032,
      last_vacuum_at: null, last_analyze_at: '2026-10-09T10:00:00Z',
    }),
  ] });
  await renderTab();
  const row = (await screen.findByText('asset')).closest('.dir-row') as HTMLElement;
  expect(within(row).getByText('12,345')).not.toBeNull();
  expect(within(row).getByText('3.0 MB')).not.toBeNull();
  expect(within(row).getByText('1.0 MB')).not.toBeNull();
  expect(within(row).getByText('2.0 MB')).not.toBeNull();
  expect(within(row).getByText('1,204 · 3.2%')).not.toBeNull();
  expect(within(row).getByText('never')).not.toBeNull();
});

it('tables list: column floors, shared template + minimum, sideways-scroll card', async () => {
  api.getHealthTables.mockResolvedValue({ tables: [table('asset')] });
  await renderTab();
  const row = (await screen.findByText('asset')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(head.style.gridTemplateColumns.endsWith('88px')).toBe(true);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.initPanel);
});

async function openVacuum(user: ReturnType<typeof userEvent.setup>, name: string) {
  const row = (await screen.findByText(name)).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: 'Vacuum & analyze' }));
  return row;
}

it('hides Vacuum & analyze without devtools:change', async () => {
  auth.canChange = false;
  api.getHealthTables.mockResolvedValue({ tables: [table('asset')] });
  await renderTab();
  const row = (await screen.findByText('asset')).closest('.dir-row') as HTMLElement;
  expect(within(row).queryByRole('button', { name: /actions/i })).toBeNull();
});

it('vacuum: confirm names the table, then the row updates and the time shows', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.getHealthTables.mockResolvedValue({ tables: [table('asset', { dead_rows: 500, dead_ratio: 0.5 })] });
  api.vacuumHealthTable.mockResolvedValue({
    table: table('asset', { dead_rows: 0, dead_ratio: 0, last_vacuum_at: new Date().toISOString() }),
    duration_ms: 1234,
  });
  const user = await renderTab();
  const row = await openVacuum(user, 'asset');

  expect(confirmSpy).toHaveBeenCalledTimes(1);
  expect(String(confirmSpy.mock.calls[0][0])).toContain('asset');
  await waitFor(() => expect(api.vacuumHealthTable).toHaveBeenCalledWith('asset'));
  expect(await screen.findByText(/Vacuumed in 1\.2 s/)).not.toBeNull();
  expect(within(row).getByText('just now')).not.toBeNull();
  expect(within(row).queryByText('500 · 50.0%')).toBeNull();
  // the table list was not reloaded: the response row replaced it in place
  expect(api.getHealthTables).toHaveBeenCalledTimes(1);
});

it('vacuum: declining the confirm calls nothing', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  api.getHealthTables.mockResolvedValue({ tables: [table('asset')] });
  const user = await renderTab();
  await openVacuum(user, 'asset');
  expect(api.vacuumHealthTable).not.toHaveBeenCalled();
});

it('vacuum: a DB Testing session shows the API message as an error', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.getHealthTables.mockResolvedValue({ tables: [table('asset')] });
  api.vacuumHealthTable.mockRejectedValue(new ApiError(409, 'testing_session_active', {
    code: 'testing_session_active',
    message: 'A DB Testing session is in progress. Finish or revert it before vacuuming tables.',
  }));
  const user = await renderTab();
  await openVacuum(user, 'asset');
  const err = await screen.findByText(/A DB Testing session is in progress/);
  expect(err.className).toMatch(/pf-error/);
  expect(screen.queryByText(/Vacuumed in/)).toBeNull();
});

it('vacuum: a busy table shows its message; other failures show a generic one', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.getHealthTables.mockResolvedValue({ tables: [table('asset')] });
  api.vacuumHealthTable
    .mockRejectedValueOnce(new ApiError(409, 'table_busy', {
      code: 'table_busy', message: 'Another session is holding a lock on that table.' }))
    .mockRejectedValueOnce(new ApiError(500, 'boom'));
  const user = await renderTab();
  await openVacuum(user, 'asset');
  expect(await screen.findByText('Another session is holding a lock on that table.')).not.toBeNull();
  await openVacuum(user, 'asset');
  expect(await screen.findByText('The vacuum failed — try again.')).not.toBeNull();
  expect(screen.queryByText('Another session is holding a lock on that table.')).toBeNull();
});

it('storage is not measured until asked', async () => {
  await renderTab();
  expect(api.getHealthStorage).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Measure storage' })).not.toBeNull();
});

it('Measure storage shows folders, totals and when it was measured', async () => {
  api.getHealthStorage.mockResolvedValue(storage());
  const user = await renderTab();
  await user.click(screen.getByRole('button', { name: 'Measure storage' }));

  const card = await screen.findByRole('region', { name: 'File storage' });
  const folder = (await within(card).findByText('attachments')).closest('.dir-row') as HTMLElement;
  expect(within(folder).getByText('1,200')).not.toBeNull();
  expect(within(folder).getByText('2.0 GB')).not.toBeNull();
  expect(within(card).getByText('(root)')).not.toBeNull();
  expect(within(card).getByText(/1,203 objects · 2\.0 GB/)).not.toBeNull();
  expect(within(card).getByText(/^Measured at /)).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Measure again' })).not.toBeNull();
});

it('Measure storage shows the unavailable message on a 502', async () => {
  api.getHealthStorage.mockRejectedValue(new ApiError(502, 'storage_unavailable', {
    code: 'storage_unavailable', message: "File storage couldn't be reached. Try again in a moment." }));
  const user = await renderTab();
  await user.click(screen.getByRole('button', { name: 'Measure storage' }));
  const err = await screen.findByText("File storage couldn't be reached. Try again in a moment.");
  expect(err.className).toMatch(/pf-error/);
  expect(screen.getByRole('button', { name: 'Measure storage' })).not.toBeNull();
});

it('vacuum: shows "Vacuuming <table>…" and disables the action while it runs', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.getHealthTables.mockResolvedValue({ tables: [table('asset')] });
  let finish: (v: unknown) => void = () => {};
  api.vacuumHealthTable.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const user = await renderTab();
  const row = await openVacuum(user, 'asset');

  expect(await screen.findByText('Vacuuming asset…')).not.toBeNull();
  await user.click(within(row).getByRole('button', { name: /actions/i }));
  const item = await screen.findByRole('menuitem', { name: 'Vacuum & analyze' });
  expect((item as HTMLButtonElement).disabled).toBe(true);
  await user.keyboard('{Escape}');

  finish({ table: table('asset'), duration_ms: 50 });
  expect(await screen.findByText(/Vacuumed in 50 ms/)).not.toBeNull();
  expect(screen.queryByText('Vacuuming asset…')).toBeNull();
});

it('Refresh clears the vacuum note and the vacuum error', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.getHealthTables.mockResolvedValue({ tables: [table('asset')] });
  api.vacuumHealthTable
    .mockResolvedValueOnce({ table: table('asset'), duration_ms: 1234 })
    .mockRejectedValueOnce(new ApiError(409, 'table_busy', {
      code: 'table_busy', message: 'Another session is holding a lock on that table.' }));
  const user = await renderTab();
  await openVacuum(user, 'asset');
  expect(await screen.findByText(/Vacuumed in 1\.2 s/)).not.toBeNull();
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(api.getHealthTables).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText(/Vacuumed in/)).toBeNull());

  await openVacuum(user, 'asset');
  expect(await screen.findByText('Another session is holding a lock on that table.')).not.toBeNull();
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.queryByText('Another session is holding a lock on that table.')).toBeNull());
});

it('vacuum: an unknown table shows the API message', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.getHealthTables.mockResolvedValue({ tables: [table('asset')] });
  api.vacuumHealthTable.mockRejectedValue(new ApiError(404, 'unknown_table', {
    code: 'unknown_table', message: "That isn't a table in this database." }));
  const user = await renderTab();
  await openVacuum(user, 'asset');
  const err = await screen.findByText("That isn't a table in this database.");
  expect(err.className).toMatch(/pf-error/);
});

it('tables list: the dead-rows floor fits "1,234,567 · 12.3%" and Connections count has a floor', async () => {
  api.getHealthTables.mockResolvedValue({ tables: [table('asset')] });
  api.getHealthConnections.mockResolvedValue({ groups: [group()] });
  await renderTab();
  await screen.findByText('asset');
  const floors = (label: string) => {
    const head = document.querySelector(`[aria-label="${label}"] .list-head`) as HTMLElement;
    return Array.from(head.style.gridTemplateColumns.matchAll(/minmax\((\d+)px/g))
      .map((m) => Number(m[1]));
  };
  // dead rows is the sixth Tables column; Count the third Connections column
  expect(floors('Tables')[5]).toBeGreaterThanOrEqual(150);
  expect(floors('Connections')[2]).toBeGreaterThanOrEqual(80);
});

it('Measure storage says so when the bucket is empty', async () => {
  api.getHealthStorage.mockResolvedValue({
    folders: [], total_objects: 0, total_bytes: 0, measured_at: '2026-10-09T15:30:00Z' });
  const user = await renderTab();
  await user.click(screen.getByRole('button', { name: 'Measure storage' }));
  expect(await screen.findByText('No files in storage.')).not.toBeNull();
  expect(screen.getByText(/^Measured at /)).not.toBeNull();
});
