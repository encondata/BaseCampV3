/** Shared fixtures for the Bulk Print page's tests (BulkPrint.test.tsx and
 *  the printing tests): the move, its synced rows, the label vocabulary,
 *  bundle builders, a fake station printer and helpers to find rows.
 *
 *  This module never imports a mocked module at runtime (the api, the
 *  station printer hook, the auth context), so a test's `vi.mock` factory
 *  may import it: `vi.mock('../lib/useStationPrinter', async () =>
 *  (await import('./bulkPrintTestHarness')).stationPrinterModule(station))`. */
import { screen, within } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';

import type { HostStatus } from '@portal/labels/zebraUsb';
import type { GeneratedLabelBundle, GeneratedLabelBundleItem, LabelVocab } from '@portal/lib/api';

import type { KioskAssetRow, KioskContainerRow, LabelStationSettings } from '../lib/api';
import { writeKioskSetup } from '../lib/kioskSetup';
import { closeDb, replaceAllMulti } from '../lib/localDb';

export type StationState = 'loading' | 'ready' | 'needs_usb' | 'no_settings';

/** The fake `useStationPrinter()`'s state; a test sets fields on it. */
export interface FakeStation {
  state: StationState;
  /** Every ZPL string `send` was given, in order. */
  sent: string[];
  /** Makes `send` fail (a USB printer unplugged mid-batch). */
  sendError: Error | null;
  /** Runs before each send is recorded; throwing (or rejecting) fails that
   *  send, and a returned promise holds the send open until it settles. */
  sendHook?: ((zpl: string) => void | Promise<void>) | null;
  connectUsb: () => Promise<void>;
  waitForIdle: (labels: number, onQueued?: (queued: number) => void) => Promise<void>;
  settings: LabelStationSettings | null;
}

export const USB_SETTINGS: LabelStationSettings = {
  label_kind: 'top', dpi: 203, offset_x: 0, offset_y: 0, peel: false,
  printer: { type: 'usb', model: 'ZD421', ip: null, serial: null },
};

export function resetStation(station: FakeStation): void {
  station.state = 'ready';
  station.sent = [];
  station.sendError = null;
  station.sendHook = null;
  station.settings = { ...USB_SETTINGS, printer: { ...USB_SETTINGS.printer } };
}

const IDLE: HostStatus = {
  paperOut: false, paused: false, labelLength: 0, formatsQueued: 0, bufferFull: false,
  partialFormat: false, corruptRam: false, underTemp: false, overTemp: false,
  headOpen: false, ribbonOut: false, thermalTransfer: false, printMode: 'T',
  labelWaiting: false, labelsRemaining: 0,
};

/** The mocked `../lib/useStationPrinter` module over `station`. */
export function stationPrinterModule(station: FakeStation) {
  const printer = {
    kind: 'usb', ip: null, serial: null,
    status: async () => IDLE,
    send: async (zpl: string) => {
      if (station.sendError) throw station.sendError;
      await station.sendHook?.(zpl);
      station.sent.push(zpl);
    },
    waitForIdle: (labels: number, onQueued?: (queued: number) => void) => station.waitForIdle(labels, onQueued),
  };
  return {
    useStationPrinter: () => ({
      settings: station.state === 'no_settings' ? null : station.settings,
      printer: station.state === 'ready' ? printer : null,
      zebra: {},
      state: station.state,
      connectUsb: station.connectUsb,
      reload: async () => {},
    }),
  };
}

// ── the move ────────────────────────────────────────────────────────

export function setupFor(initiativeId: string) {
  return {
    initiativeId, initiativeName: `Move ${initiativeId}`, siteId: 's-1', siteName: 'ACC4',
    siteRole: 'source' as const, scanStatus: 'k', scanLabel: 'Labels',
  };
}

export const ASSETS: KioskAssetRow[] = [
  {
    id: 'a-1', asset_id: '10001', name: 'Rack A01 server', rfid: null, serial_number: 'SN-1',
    make: 'Dell', model: 'R640', make_model: 'Dell R640', label: {}, legacy_id: 10001,
    source_rack: 'A01', source_ru: '20', roster_status_label: 'Planned',
  },
  {
    id: 'a-2', asset_id: '10002', name: 'Spare switch', rfid: null, serial_number: 'SN-2',
    make: 'Cisco', model: 'C9300', make_model: 'Cisco C9300', label: {}, legacy_id: 10002,
    source_rack: 'A02', source_ru: '10', roster_status_label: 'Planned',
  },
];

export const CONTAINERS: KioskContainerRow[] = [
  {
    id: 'c-1', name: 'Crate 7', rfid_tag: null, label_tag: null, container_type: 'crate',
    container_type_label: 'Crate', status: 'open', status_label: 'Open', site_id: 's-1',
    site_name: 'ACC4', asset_count: 0,
  },
];

/** A fresh database holding `initiativeId`'s setup and synced rows, the
 *  sync meta naming `syncedFor` (the same move unless a test says not). */
export async function seedMove(
  initiativeId = 'i-1', syncedFor = initiativeId, assets: KioskAssetRow[] = ASSETS,
): Promise<void> {
  localStorage.clear();
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  await writeSyncedRows(syncedFor, assets);
  writeKioskSetup(setupFor(initiativeId));
}

export async function writeSyncedRows(syncedFor: string, assets: KioskAssetRow[] = ASSETS): Promise<void> {
  await replaceAllMulti(
    [{ store: 'assets', rows: assets }, { store: 'containers', rows: CONTAINERS }],
    { key: 'sync', value: { initiativeId: syncedFor, assets: assets.length } },
  );
}

// ── labels ──────────────────────────────────────────────────────────

function vocabRow(key: string, label: string, sort: number, meta: Record<string, unknown> = {}): LabelVocab {
  return {
    kind: 'type', key, label, description: '', meta, sort_order: sort, is_active: true, usage_count: null,
  };
}

export const VOCAB: LabelVocab[] = [
  vocabRow('top', 'Top Label', 1),
  vocabRow('front', 'Front Label', 2),
  vocabRow('container', 'Container Label', 3, { default_copies: 5 }),
  vocabRow('id_badge', 'ID Badge', 4),
];

export function label(
  entityId: string, dpi = '203', opts: Partial<GeneratedLabelBundleItem> = {},
): GeneratedLabelBundleItem {
  return {
    id: `g-${entityId}-${dpi}`, entity_type: entityId.startsWith('c-') ? 'container' : 'asset',
    entity_id: entityId, template_id: 't-1', template_name: 'Generic', template_version: 1,
    language_key: 'zpl', size_key: '4x2', dpi_key: dpi, stale: false,
    generated_at: '2026-11-08T08:00:00Z', code: `^XA^FD${entityId}@${dpi}^FS^XZ`, ...opts,
  };
}

export function bundle(
  labelType: string, labels: GeneratedLabelBundleItem[], initiativeId = 'i-1',
): GeneratedLabelBundle {
  return { initiative_id: initiativeId, label_type: labelType, fetched_at: '2026-11-08T08:00:00Z', labels };
}

export interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ── finding things on the page ──────────────────────────────────────

/** The list row whose checkbox is "Select <name>". */
export async function findRow(name: string): Promise<HTMLElement> {
  const box = await screen.findByRole('checkbox', { name: `Select ${name}` });
  return box.closest('[role="listitem"]') as HTMLElement;
}

export function queryRow(name: string): HTMLElement | null {
  const box = screen.queryByRole('checkbox', { name: `Select ${name}` });
  return (box?.closest('[role="listitem"]') as HTMLElement | null) ?? null;
}

/** The row's Label column chip ("Ready", "Missing", …). */
export function labelChip(row: HTMLElement): string {
  const chips = within(row).queryAllByText(/^(Ready|Stale|Missing|Unsupported)$/);
  return chips.map((c) => c.textContent).join(',');
}

/** The label type cards' titles, in order. */
export function typeCardTitles(): string[] {
  const group = screen.getByRole('radiogroup', { name: 'Label type' });
  return within(group).queryAllByRole('radio')
    .map((r) => r.querySelector('.rgm-choice-title')?.textContent ?? '');
}

export function typeCard(title: string): HTMLElement {
  const group = screen.getByRole('radiogroup', { name: 'Label type' });
  const card = within(group).getAllByRole('radio')
    .find((r) => r.querySelector('.rgm-choice-title')?.textContent === title);
  if (!card) throw new Error(`no ${title} card`);
  return card;
}

/** An element whose own text is exactly `text`, across its child nodes. */
export function byFullText(text: string, tag = 'P') {
  return (_: string, el: Element | null) => el?.tagName === tag && el.textContent === text;
}
