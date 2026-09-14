// @vitest-environment jsdom
/** LocalDataInspector against fake-indexeddb — seeds the three stores
 *  directly via `localDb` and asserts what the three `<details>` sections
 *  render: counts, tables, the filter, the Label toggle, and the empty
 *  and 200-row-cap cases. */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const syncMock = vi.hoisted(() => ({
  status: { phase: 'idle' } as { phase: string },
}));
vi.mock('../lib/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sync')>();
  return { ...actual, useSyncStatus: () => syncMock.status };
});

import { closeDb, replaceAllMulti } from '../lib/localDb';
import LocalDataInspector from './LocalDataInspector';

type Asset = {
  id: string; asset_id: string; name: string | null; rfid: string | null;
  serial_number: string | null; make: string | null; model: string | null;
  make_model: string; label: Record<string, string>;
};
type Person = {
  id: string; display_name: string; rfid_tag: string | null;
  is_worker: boolean; has_account: boolean;
};

function asset(n: number, overrides: Partial<Asset> = {}): Asset {
  return {
    id: `a-${n}`, asset_id: `${10000 + n}`, name: `core-sw-${n}`, rfid: `E28${n}`,
    serial_number: `SN${n}`, make: 'Cisco', model: 'Nexus', make_model: 'Cisco Nexus',
    label: { asset_id: `${10000 + n}`, source_site: 'Rack 12' },
    ...overrides,
  };
}

function person(n: number, overrides: Partial<Person> = {}): Person {
  return {
    id: `p-${n}`, display_name: `Worker ${n}`, rfid_tag: `W-${n}`,
    is_worker: true, has_account: false,
    ...overrides,
  };
}

const ASSETS3 = [
  asset(1),
  asset(2, { rfid: 'UNIQUE-RFID', name: 'special-switch' }),
  asset(3),
];
const PEOPLE2 = [
  person(1, { is_worker: true, has_account: false }),
  person(2, { display_name: 'Alice Account', is_worker: false, has_account: true }),
];
const META = {
  initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration (demo)',
  assets: 3, people: 2, syncedAt: '2026-09-13T18:14:00Z',
};

async function seed(entries: { assets?: Asset[]; people?: Person[]; meta?: typeof META }) {
  await replaceAllMulti(
    [
      { store: 'assets', rows: entries.assets ?? [] },
      { store: 'people', rows: entries.people ?? [] },
    ],
    entries.meta ? { key: 'sync', value: entries.meta } : undefined,
  );
}

beforeEach(() => {
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  syncMock.status = { phase: 'idle' };
});

afterEach(() => {
  cleanup();
});

it('shows the three section summaries with counts, once loaded', async () => {
  await seed({ assets: ASSETS3, people: PEOPLE2, meta: META });
  render(<LocalDataInspector />);

  expect(await screen.findByText('Assets · 3')).toBeTruthy();
  expect(screen.getByText('People · 2')).toBeTruthy();
  expect(screen.getByText('Sync metadata')).toBeTruthy();
});

it('lists the three asset IDs in the assets table', async () => {
  await seed({ assets: ASSETS3, people: PEOPLE2, meta: META });
  render(<LocalDataInspector />);

  await screen.findByText('Assets · 3');
  for (const a of ASSETS3) {
    expect(screen.getByText(a.asset_id)).toBeTruthy();
  }
});

it('filtering assets by RFID narrows to one row and updates the count line', async () => {
  await seed({ assets: ASSETS3, people: PEOPLE2, meta: META });
  render(<LocalDataInspector />);

  await screen.findByText('Assets · 3');
  const input = screen.getByPlaceholderText('Filter assets…');
  await userEvent.type(input, 'UNIQUE-RFID');

  expect(screen.getByText('special-switch')).toBeTruthy();
  expect(screen.queryByText(ASSETS3[0].asset_id)).toBeNull();
  expect(screen.getByText('Showing 1 of 1 matching (of 3)')).toBeTruthy();
});

it('toggling Label reveals the label key/value list', async () => {
  await seed({ assets: ASSETS3, people: PEOPLE2, meta: META });
  render(<LocalDataInspector />);

  await screen.findByText('Assets · 3');
  const labelButtons = screen.getAllByRole('button', { name: 'Label' });
  await userEvent.click(labelButtons[0]);

  expect(screen.getByText('source_site')).toBeTruthy();
  expect(screen.getByText('Rack 12')).toBeTruthy();
});

it('the people table shows worker/account chips', async () => {
  await seed({ assets: ASSETS3, people: PEOPLE2, meta: META });
  render(<LocalDataInspector />);

  await screen.findByText('Assets · 3');
  await userEvent.click(screen.getByText('People · 2'));

  const workerRow = screen.getByText('Worker 1').closest('tr')!;
  expect(within(workerRow).getByText('worker')).toBeTruthy();

  const accountRow = screen.getByText('Alice Account').closest('tr')!;
  expect(within(accountRow).getByText('account')).toBeTruthy();
});

it('the metadata section shows the initiative name', async () => {
  await seed({ assets: ASSETS3, people: PEOPLE2, meta: META });
  render(<LocalDataInspector />);

  await screen.findByText('Assets · 3');
  await userEvent.click(screen.getByText('Sync metadata'));

  expect(screen.getByText('NAP11 Hall Migration (demo)')).toBeTruthy();
});

it('caps the assets table at 200 rows and reports the truncated count', async () => {
  const many = Array.from({ length: 250 }, (_, i) => asset(i + 1));
  await seed({ assets: many, people: [], meta: { ...META, assets: 250, people: 0 } });
  render(<LocalDataInspector />);

  await screen.findByText('Assets · 250');
  expect(screen.getByText('Showing 200 of 250')).toBeTruthy();
});

it('shows empty copy when the stores are empty', async () => {
  render(<LocalDataInspector />);

  expect(await screen.findByText('No assets downloaded yet.')).toBeTruthy();
  await userEvent.click(screen.getByText(/^People/));
  expect(screen.getByText('No people downloaded yet.')).toBeTruthy();
  await userEvent.click(screen.getByText('Sync metadata'));
  expect(screen.getByText('No sync recorded.')).toBeTruthy();
});

it('re-reads the stores when sync phase becomes done', async () => {
  const { rerender } = render(<LocalDataInspector />);
  await screen.findByText('No assets downloaded yet.');

  await seed({ assets: ASSETS3, people: PEOPLE2, meta: META });
  syncMock.status = { phase: 'done' };
  rerender(<LocalDataInspector />);

  expect(await screen.findByText('Assets · 3')).toBeTruthy();
});
