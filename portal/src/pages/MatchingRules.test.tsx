// @vitest-environment jsdom
/**
 * /dev/matching-rules — the management page: the place switch, the versions
 * table, the check panel, the test assets panel and their dialogs.
 *
 * The open RowActionsMenu is portaled to document.body, so menu items are
 * queried via `screen` and never `within(row)` (pages/KioskDevices.test.tsx:178).
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError,
  type MatchingCheck, type MatchingTestAsset, type MatchingVersion, type MatchingVersionDetail,
} from '../lib/api';
import TestAssetModal from '../components/matching/TestAssetModal';
import MatchingRules from './MatchingRules';

const api = vi.hoisted(() => ({
  listMatchingVersions: vi.fn(),
  getMatchingVersion: vi.fn(),
  standbyMatchingVersion: vi.fn(),
  deployMatchingVersion: vi.fn(),
  rollbackMatchingVersion: vi.fn(),
  listMatchingTestAssets: vi.fn(),
  createMatchingTestAsset: vi.fn(),
  updateMatchingTestAsset: vi.fn(),
  deleteMatchingTestAsset: vi.fn(),
  createMatchingTestRow: vi.fn(),
  updateMatchingTestRow: vi.fn(),
  deleteMatchingTestRow: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

function version(overrides: Partial<MatchingVersion> = {}): MatchingVersion {
  return {
    id: 'v1id',
    place: 'printing',
    version: 1,
    state: 'live',
    based_on_version: null,
    saved_by_name: null,
    saved_at: '2026-11-10T09:00:00Z',
    state_changed_at: null,
    checked: null,
    current: { passed: 9, total: 9, ok: true, checked_at: null },
    ...overrides,
  };
}

function check(overrides: Partial<MatchingCheck> = {}): MatchingCheck {
  return {
    ok: true,
    structure_ok: true,
    tests_ok: true,
    passed: 9,
    total: 9,
    structure: [{ code: 'wired', label: 'Every output is wired to one step', ok: true, problems: [] }],
    tests: [],
    ...overrides,
  };
}

function detail(v: MatchingVersion, c: MatchingCheck = check()): MatchingVersionDetail {
  return { ...v, flow: { format: 1, nodes: [], edges: [] }, check: c };
}

function testAsset(n: number, overrides: Partial<MatchingTestAsset> = {}): MatchingTestAsset {
  return {
    id: `a${n}`, asset_tag: n, name: `Test asset ${n}`, rfid: null, serial: null, sits: 'move', rows: [],
    ...overrides,
  };
}

let versions: MatchingVersion[] = [];

beforeEach(() => {
  versions = [version()];
  api.listMatchingVersions.mockReset().mockImplementation(async () => versions);
  api.getMatchingVersion.mockReset().mockImplementation(async (id: string) => {
    const v = versions.find((x) => x.id === id) ?? versions[0];
    return detail(v);
  });
  api.standbyMatchingVersion.mockReset();
  api.deployMatchingVersion.mockReset();
  api.rollbackMatchingVersion.mockReset();
  api.listMatchingTestAssets.mockReset().mockResolvedValue([]);
  api.createMatchingTestAsset.mockReset();
  api.updateMatchingTestAsset.mockReset();
  api.deleteMatchingTestAsset.mockReset();
  api.createMatchingTestRow.mockReset();
  api.updateMatchingTestRow.mockReset();
  api.deleteMatchingTestRow.mockReset();
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Probe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderPage() {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/dev/matching-rules']}>
      <Routes>
        <Route path="/dev/matching-rules" element={<MatchingRules />} />
        <Route path="/dev/matching-rules/versions/:id" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
  return user;
}

/** The versions table row whose Version cell reads `label`. */
async function versionRow(label: string): Promise<HTMLElement> {
  const table = await screen.findByRole('table', { name: 'Versions' });
  const cell = await within(table).findByText(label);
  return cell.closest('tr') as HTMLElement;
}

it("shows live v1 with today's result", async () => {
  renderPage();
  const row = await versionRow('v1');
  expect(row.textContent).toContain('Live');
  expect(row.textContent).toContain('System');
  expect(row.textContent).toContain('9 of 9');
  expect(api.listMatchingVersions).toHaveBeenLastCalledWith('printing');
});

it('switching to Scanning loads its versions', async () => {
  const user = renderPage();
  await versionRow('v1');
  await user.click(screen.getByRole('tab', { name: 'Scanning' }));
  await waitFor(() => expect(api.listMatchingVersions).toHaveBeenLastCalledWith('scanning'));
  expect(screen.getByRole('tab', { name: 'Scanning' }).getAttribute('aria-selected')).toBe('true');
});

it("a slow place's versions never land after the place switched", async () => {
  let answerPrinting: (v: MatchingVersion[]) => void = () => {};
  const scanning = [version({ id: 'v4id', place: 'scanning', version: 4 })];
  api.listMatchingVersions.mockImplementation((place: string) => (place === 'printing'
    ? new Promise<MatchingVersion[]>((r) => { answerPrinting = r; })
    : Promise.resolve(scanning)));
  const user = renderPage();
  await user.click(screen.getByRole('tab', { name: 'Scanning' }));
  await versionRow('v4');

  answerPrinting([version()]);
  await waitFor(() => expect(api.getMatchingVersion).toHaveBeenCalledWith('v4id'));
  await new Promise((r) => setTimeout(r, 0));
  const table = screen.getByRole('table', { name: 'Versions' });
  expect(within(table).queryByText('v1')).toBeNull();
  expect(within(table).getByText('v4')).toBeTruthy();
});

it('Deploy asks first, then deploys and reloads', async () => {
  versions = [version({ id: 'v2id', version: 2, state: 'draft' }), version()];
  api.deployMatchingVersion.mockResolvedValue(detail(versions[0]));
  const user = renderPage();
  const row = await versionRow('v2');

  await user.click(within(row).getByRole('button', { name: /actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: 'Deploy' }));

  const dialog = await screen.findByRole('dialog');
  expect(dialog.className).toMatch(/rgm-card/);
  expect(within(dialog).getByText('v2 becomes the live Printing flow, and v1 is retired.')).toBeTruthy();
  expect(api.deployMatchingVersion).not.toHaveBeenCalled();

  const before = api.listMatchingVersions.mock.calls.length;
  await user.click(within(dialog).getByRole('button', { name: 'Deploy' }));

  await waitFor(() => expect(api.deployMatchingVersion).toHaveBeenCalledWith('v2id'));
  await waitFor(() => expect(api.listMatchingVersions.mock.calls.length).toBeGreaterThan(before));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('a failing deploy keeps the dialog and fills the check panel', async () => {
  versions = [version({ id: 'v2id', version: 2, state: 'draft' }), version()];
  const failing = check({
    ok: false, structure_ok: false,
    structure: [{
      code: 'wired', label: 'Every output is wired to one step', ok: false,
      problems: [{ message: 'Problem 1', node_ids: ['n3'] }],
    }],
  });
  api.deployMatchingVersion.mockRejectedValue(
    new ApiError(422, 'check_failed', { code: 'check_failed', check: failing }),
  );
  const user = renderPage();
  const row = await versionRow('v2');

  await user.click(within(row).getByRole('button', { name: /actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: 'Deploy' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Deploy' }));

  expect(await within(dialog).findByText("v2 doesn't pass the check. The check panel shows what's wrong."))
    .toBeTruthy();
  expect(screen.queryByRole('dialog')).not.toBeNull();

  const panel = screen.getByRole('region', { name: 'Check · v2' });
  const item = within(panel).getByText('Every output is wired to one step').closest('li') as HTMLElement;
  expect(item.textContent).toContain('✗');
  expect(item.textContent).toContain('Problem 1');
});

it("flags a live version that fails today", async () => {
  versions = [version({ current: { passed: 8, total: 9, ok: false, checked_at: null } })];
  renderPage();
  const row = await versionRow('v1');
  expect(row.textContent).toContain('8 of 9');
  expect(within(row).getByText("Fails today's test set")).toBeTruthy();
});

it('Roll back to is offered only on retired rows', async () => {
  versions = [
    version({ id: 'v3id', version: 3, state: 'draft' }),
    version({ id: 'v2id', version: 2, state: 'live' }),
    version({ id: 'v1id', version: 1, state: 'retired' }),
  ];
  const user = renderPage();

  const menuFor = async (label: string): Promise<string[]> => {
    const row = await versionRow(label);
    await user.click(within(row).getByRole('button', { name: /actions/i }));
    const items = (await screen.findAllByRole('menuitem')).map((m) => m.textContent ?? '');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    return items;
  };

  expect(await menuFor('v3')).toEqual(['Open', 'Deploy']);
  expect(await menuFor('v2')).toEqual(['Open']);
  expect(await menuFor('v1')).toEqual(['Open', 'Roll back to']);
});

it('test assets: Add is disabled at 10; the under-5 hint shows', async () => {
  api.listMatchingTestAssets.mockResolvedValue(Array.from({ length: 10 }, (_, i) => testAsset(i + 1)));
  renderPage();
  const full = await screen.findByRole('button', { name: 'Add test asset' });
  await waitFor(() => expect((full as HTMLButtonElement).disabled).toBe(true));
  expect(screen.getByText('The test set holds at most 10 assets.')).toBeTruthy();
  expect(screen.queryByText('The test set should have 5 to 10 assets.')).toBeNull();
  cleanup();

  api.listMatchingTestAssets.mockResolvedValue([testAsset(1), testAsset(2), testAsset(3)]);
  renderPage();
  expect(await screen.findByText('The test set should have 5 to 10 assets.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Add test asset' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText('The test set holds at most 10 assets.')).toBeNull();
});

it('test assets list one line per row of this place, with its result', async () => {
  const a1 = testAsset(1, {
    rows: [
      { id: 'r1', test_asset_id: 'a1', place: 'printing', value: '1', expected: 'asset_tag' },
      { id: 'r2', test_asset_id: 'a1', place: 'scanning', value: '2', expected: 'rfid' },
    ],
  });
  const a2 = testAsset(2, {
    rows: [{ id: 'r3', test_asset_id: 'a2', place: 'printing', value: '3', expected: 'not_found' }],
  });
  const a3 = testAsset(3);
  api.listMatchingTestAssets.mockResolvedValue([a1, a2, a3]);
  api.getMatchingVersion.mockResolvedValue(detail(versions[0], check({
    passed: 1, total: 2,
    tests: [
      { row_id: 'r1', test_asset_id: 'a1', asset_tag: 1, asset_name: 'Test asset 1', value: '1',
        expected: 'asset_tag', outcome: 'found', found_asset_tag: 1, found_field: 'asset_tag', passed: true },
      { row_id: 'r3', test_asset_id: 'a2', asset_tag: 2, asset_name: 'Test asset 2', value: '3',
        expected: 'not_found', outcome: 'found', found_asset_tag: 3, found_field: 'serial', passed: false },
    ],
  })));
  renderPage();
  const table = await screen.findByRole('table', { name: 'Test assets' });
  await within(table).findByText('Pass');
  const body = within(table).getAllByRole('row').slice(1);
  expect(body).toHaveLength(3);
  expect(body[0].textContent).toContain('Found by asset tag');
  expect(body[1].textContent).toContain('Fail: found by serial on 3');
  expect(body[2].textContent).toContain('Test asset 3');
  expect(body[2].textContent).toContain('—');
});

it('TestAssetModal saves the asset then its rows; a duplicate value shows the message', async () => {
  const created = testAsset(1);
  api.createMatchingTestAsset.mockResolvedValue(created);
  api.createMatchingTestRow
    .mockResolvedValueOnce({ id: 'r1', test_asset_id: 'a1', place: 'printing', value: '1', expected: 'asset_tag' })
    .mockRejectedValueOnce(new ApiError(409, 'duplicate_value', { code: 'duplicate_value' }));
  const onSaved = vi.fn();
  const user = userEvent.setup();
  render(<TestAssetModal asset={null} onClose={vi.fn()} onSaved={onSaved} />);

  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('heading', { name: 'Add test asset' })).toBeTruthy();
  await user.type(within(dialog).getByLabelText('Asset tag'), '1');
  await user.type(within(dialog).getByLabelText('Name'), 'Test asset 1');
  await user.click(within(dialog).getByRole('button', { name: 'Add expected result' }));
  await user.click(within(dialog).getByRole('button', { name: 'Add expected result' }));
  const values = within(dialog).getAllByLabelText('Value to try');
  await user.type(values[0], '1');
  await user.type(values[1], '1');
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.createMatchingTestRow).toHaveBeenCalledTimes(2));
  expect(api.createMatchingTestAsset).toHaveBeenCalledWith({
    asset_tag: 1, name: 'Test asset 1', rfid: null, serial: null, sits: 'move',
  });
  expect(api.createMatchingTestRow).toHaveBeenNthCalledWith(1, 'a1', {
    place: 'printing', value: '1', expected: 'asset_tag',
  });
  expect(api.createMatchingTestAsset.mock.invocationCallOrder[0])
    .toBeLessThan(api.createMatchingTestRow.mock.invocationCallOrder[0]);
  expect(await within(dialog).findByText('Printing already has an expected result for "1".')).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
});

it('TestAssetModal edits: updates the asset and its rows, deletes a removed row', async () => {
  const asset = testAsset(4, {
    rows: [
      { id: 'r1', test_asset_id: 'a4', place: 'printing', value: '4', expected: 'asset_tag' },
      { id: 'r2', test_asset_id: 'a4', place: 'scanning', value: '5', expected: 'rfid' },
    ],
  });
  api.updateMatchingTestAsset.mockResolvedValue(asset);
  api.updateMatchingTestRow.mockResolvedValue(asset.rows[0]);
  api.deleteMatchingTestRow.mockResolvedValue(undefined);
  const onSaved = vi.fn();
  const user = userEvent.setup();
  render(<TestAssetModal asset={asset} onClose={vi.fn()} onSaved={onSaved} />);

  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('heading', { name: 'Edit test asset' })).toBeTruthy();
  const values = within(dialog).getAllByLabelText('Value to try');
  await user.type(values[0], '0');
  await user.click(within(dialog).getAllByRole('button', { name: 'Remove' })[1]);
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.updateMatchingTestAsset).toHaveBeenCalledWith('a4', {
    asset_tag: 4, name: 'Test asset 4', rfid: null, serial: null, sits: 'move',
  });
  expect(api.deleteMatchingTestRow).toHaveBeenCalledWith('r2');
  expect(api.updateMatchingTestRow).toHaveBeenCalledWith('r1', {
    place: 'printing', value: '40', expected: 'asset_tag',
  });
  expect(api.createMatchingTestRow).not.toHaveBeenCalled();
});

it('Delete test asset confirms first', async () => {
  api.listMatchingTestAssets.mockResolvedValue([testAsset(1)]);
  api.deleteMatchingTestAsset.mockResolvedValue(undefined);
  const user = renderPage();
  const table = await screen.findByRole('table', { name: 'Test assets' });
  const row = (await within(table).findByText('Test asset 1')).closest('tr') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('heading', { name: 'Delete test asset 1' })).toBeTruthy();
  expect(within(dialog).getByText('Its expected results are deleted with it.')).toBeTruthy();
  expect(api.deleteMatchingTestAsset).not.toHaveBeenCalled();
  const del = within(dialog).getByRole('button', { name: 'Delete' });
  expect(del.className).toMatch(/btn-danger/);
  await user.click(del);
  await waitFor(() => expect(api.deleteMatchingTestAsset).toHaveBeenCalledWith('a1'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('Edit flow opens the editor for the selected version', async () => {
  versions = [version({ id: 'v2id', version: 2, state: 'draft' }), version()];
  const user = renderPage();
  await versionRow('v1');
  // the selection defaults to the live row
  await user.click(screen.getByRole('button', { name: 'Edit flow' }));
  expect(screen.getByTestId('loc').textContent).toBe('/dev/matching-rules/versions/v1id');
});

it('clicking a row selects it; the toolbar buttons follow its state', async () => {
  versions = [version({ id: 'v2id', version: 2, state: 'draft' }), version()];
  const user = renderPage();
  await versionRow('v1');
  const standby = screen.getByRole('button', { name: 'Save as standby' }) as HTMLButtonElement;
  const deploy = screen.getAllByRole('button', { name: 'Deploy' })[0] as HTMLButtonElement;
  expect(standby.disabled).toBe(true);
  expect(deploy.disabled).toBe(true);

  await user.click(await versionRow('v2'));
  await waitFor(() => expect(standby.disabled).toBe(false));
  expect(deploy.disabled).toBe(false);
  expect(await screen.findByRole('region', { name: 'Check · v2' })).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Run tests' }));
  await waitFor(() => expect(api.getMatchingVersion).toHaveBeenLastCalledWith('v2id'));
});

it('Escape in an open ComboBox closes only its list, not the TestAssetModal', async () => {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const user = userEvent.setup();
  render(<TestAssetModal asset={null} onClose={onClose} onSaved={onSaved} />);
  const dialog = screen.getByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Add expected result' }));
  await user.click(within(dialog).getByRole('combobox', { name: 'Should find' }));
  // the list's entries are buttons (ComboBox), portaled out of the card
  expect(await screen.findByRole('button', { name: 'Found by serial' })).toBeTruthy();

  await user.keyboard('{Escape}');

  await waitFor(() => expect(screen.queryByRole('button', { name: 'Found by serial' })).toBeNull());
  expect(screen.queryByRole('dialog')).not.toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();

  // a second Escape, with no list open, closes the dialog
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalled();
});

it('a failed test-assets load stays shown, with no empty-set hints and Add off', async () => {
  api.listMatchingTestAssets.mockRejectedValue(new ApiError(500, 'unknown_error'));
  renderPage();
  expect(await screen.findByText("Couldn't load the test assets.")).toBeTruthy();
  // the versions load succeeds after it, and does not clear it
  await versionRow('v1');
  await waitFor(() => expect(api.getMatchingVersion).toHaveBeenCalled());
  expect(screen.getByText("Couldn't load the test assets.")).toBeTruthy();
  expect(screen.queryByText('The test set should have 5 to 10 assets.')).toBeNull();
  expect(screen.queryByRole('table', { name: 'Test assets' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Add test asset' }) as HTMLButtonElement).disabled).toBe(true);
});

it('a failed check load shows its error in the check panel, not Loading…', async () => {
  api.getMatchingVersion.mockRejectedValue(new ApiError(500, 'unknown_error'));
  renderPage();
  const panel = await screen.findByRole('region', { name: 'Check · v1' });
  expect(await within(panel).findByText("Couldn't load the check.")).toBeTruthy();
  expect(within(panel).queryByText('Loading…')).toBeNull();
  // the other loads are unaffected
  expect(await screen.findByRole('table', { name: 'Test assets' })).toBeTruthy();
  expect(screen.queryByText("Couldn't load the versions.")).toBeNull();
});
