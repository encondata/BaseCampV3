// @vitest-environment jsdom
/**
 * The label backend seam: on the laptop every call is the edge route it
 * always was; on the web kiosk each has a local stand-in — settings in
 * localStorage, the plan and labels from the browser build, the Labeled
 * scan through the outbox — and no `/edge/*` route is ever called.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  getLabelStation: vi.fn(),
  putLabelStation: vi.fn(),
  getLabelPlan: vi.fn(),
  getStationLabel: vi.fn(),
  postLabelPrinted: vi.fn(),
  getRecordedScans: vi.fn(),
  getLabelRunStatus: vi.fn(),
}));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  ...apiMock,
}));

const syncState = vi.hoisted(() => ({ phase: 'done' as 'idle' | 'running' | 'done' | 'error' }));
vi.mock('./sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sync')>()),
  readSyncStatus: () => ({ phase: syncState.phase }),
}));

// The build's status and plan are Task 3's (labelBuild.test.ts); here
// only what the backend does with them matters.
const build = vi.hoisted(() => ({
  status: {
    state: 'idle', reason: null, total: 0, done: 0, ready: 0, errors: 0, unsupported: 0,
  } as Record<string, unknown>,
  plan: vi.fn(),
}));
vi.mock('./webLabels/labelBuild', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./webLabels/labelBuild')>()),
  readWebLabelStatus: () => build.status,
  requestLabelPlan: build.plan,
}));

import type { Plan } from '../labelgen/plan';
import { ApiError, type KioskLabelTemplate, type LabelStationSettings } from './api';
import { writeKioskSetup } from './kioskSetup';
import { edgeLabelBackend, labelBackend, webLabelBackend } from './labelBackend';
import { closeDb, getAll, putRows, writeMeta } from './localDb';
import { loadOutbox, readOutbox, resetOutboxForTest, type OutboxRow } from './outbox';
import type { PrintAsset, PrintedJob } from './printQueue';
import { readWebLabelSettings, writeWebLabelSettings } from './webLabelSettings';
import type { WebLabelRow } from './webLabels/labelBuild';

const ASSET: PrintAsset = {
  id: 'a-1', asset_id: '10042', name: 'Rack 4 server', rfid: 'E200001', serial_number: 'SN-4242',
  make: 'Dell', model: 'R640', make_model: 'Dell R640',
  label: { source_raw: 'A12', source_ru: '22' },
};

function setUpMove(initiativeId = 'm-1'): void {
  writeKioskSetup({
    initiativeId, initiativeName: `Move ${initiativeId}`, siteId: 's-1', siteName: 'ORD1',
    // not 'labeled': the printed label's scan says Labeled whatever the station scans as
    siteRole: 'source', scanStatus: 'k', scanLabel: 'Dock',
  });
}

function settings(over: Partial<LabelStationSettings> = {}): LabelStationSettings {
  return {
    label_kind: 'top', printer: { type: 'usb', ip: null, model: 'ZD421', serial: 'ZD-1' },
    dpi: 203, offset_x: 0, offset_y: 0, peel: false, ...over,
  };
}

function row(over: Partial<WebLabelRow> = {}): WebLabelRow {
  return {
    asset_id: 'a-1', zpl: '^XA^FDLABEL^FS^XZ', error: null, fingerprint: '0123456789abcd',
    template_name: 'Vegas · 203', dpi: 203, label_kind: 'top', initiativeId: 'm-1', ...over,
  };
}

function template(over: Partial<KioskLabelTemplate> = {}): KioskLabelTemplate {
  return {
    id: 't-1', name: 'Vegas · 300', family: 'Vegas', label_type: 'front', size_key: '2x1', dpi_key: '300',
    language_key: 'zpl', version: 4, updated_at: '2026-10-19T00:00:00Z', move_site_names: [],
    reasons: ['generic'], code: '', generation_rules: {}, width_in: 2, height_in: 1, dots: 300, error: null,
    ...over,
  };
}

function plan(over: Partial<Plan> = {}): Plan {
  return {
    templateId: null, templateFamily: null, notes: [], fonts: [], availableDpis: [], hasAssetData: true,
    jobs: [], ...over,
  };
}

function job(over: Partial<PrintedJob> = {}): PrintedJob {
  return {
    asset: ASSET, assetId: ASSET.id, scannedValue: 'sn-4242', scannedAt: '2026-11-04T10:00:00.000Z', ...over,
  };
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return { status: (err as ApiError).status, code: (err as ApiError).code };
}

beforeEach(() => {
  localStorage.clear();
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  resetOutboxForTest();
  syncState.phase = 'done';
  build.status = { state: 'idle', reason: 'setup', total: 1, done: 1, ready: 1, errors: 0, unsupported: 0 };
  build.plan.mockReset().mockResolvedValue(null);
  for (const fn of Object.values(apiMock)) fn.mockReset();
});
afterEach(() => {
  delete window.__KIOSK_CONFIG__;
  resetOutboxForTest();
});

it('labelBackend() is the edge on a laptop and the web backend everywhere else', () => {
  expect(labelBackend()).toBe(webLabelBackend);
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  expect(labelBackend()).toBe(edgeLabelBackend);
  expect(edgeLabelBackend).toMatchObject({ kind: 'edge', deviceWord: 'laptop', printerTypes: ['usb', 'network'] });
  expect(webLabelBackend).toMatchObject({ kind: 'web', deviceWord: 'kiosk', printerTypes: ['usb'] });
});

describe('edge backend calls the edge functions', () => {
  it('getSettings reads GET /edge/label-station', async () => {
    apiMock.getLabelStation.mockResolvedValue(settings());
    expect(await edgeLabelBackend.getSettings()).toEqual(settings());
    expect(apiMock.getLabelStation).toHaveBeenCalledWith();
  });

  it('saveSettings is PUT /edge/label-station with the settings as given', async () => {
    const network = settings({ printer: { type: 'network', ip: '10.0.0.40', model: 'ZD421', serial: null } });
    apiMock.putLabelStation.mockImplementation(async (s: LabelStationSettings) => s);
    expect(await edgeLabelBackend.saveSettings(network)).toEqual(network);
    expect(apiMock.putLabelStation).toHaveBeenCalledWith(network);
  });

  it('getPlan is GET /edge/labels/plan with the same options', async () => {
    const answer = { template: null, notes: [], available_dpis: ['300'] };
    apiMock.getLabelPlan.mockResolvedValue(answer);
    expect(await edgeLabelBackend.getPlan({ dpi: 203, kind: 'front' })).toBe(answer);
    expect(apiMock.getLabelPlan).toHaveBeenCalledWith({ dpi: 203, kind: 'front' });
  });

  it('getLabel is GET /edge/labels/asset/:id', async () => {
    const label = { asset_id: 'a-1', zpl: '^XA^XZ', error: null, template_name: 'T', dpi: 203, label_kind: 'top' };
    apiMock.getStationLabel.mockResolvedValue(label);
    expect(await edgeLabelBackend.getLabel('a-1')).toBe(label);
    expect(apiMock.getStationLabel).toHaveBeenCalledWith('a-1');
  });

  it('recordPrinted is POST /edge/labels/printed with the asset id, scanned value and time', async () => {
    apiMock.postLabelPrinted.mockResolvedValue('c-1');
    expect(await edgeLabelBackend.recordPrinted(job())).toBe('c-1');
    expect(apiMock.postLabelPrinted).toHaveBeenCalledWith({
      asset_id: 'a-1', scanned_value: 'sn-4242', scanned_at: '2026-11-04T10:00:00.000Z',
    });
  });

  it('recordedIds is GET /edge/labels/recorded', async () => {
    apiMock.getRecordedScans.mockResolvedValue(['c-1']);
    expect(await edgeLabelBackend.recordedIds(['c-1', 'c-2'])).toEqual(['c-1']);
    expect(apiMock.getRecordedScans).toHaveBeenCalledWith(['c-1', 'c-2']);
  });

  it('getStatus is GET /edge/labels/status', async () => {
    const status = { state: 'idle', reason: null, total: 0, done: 0, ready: 0, errors: 0 };
    apiMock.getLabelRunStatus.mockResolvedValue(status);
    expect(await edgeLabelBackend.getStatus()).toBe(status);
    expect(apiMock.getLabelRunStatus).toHaveBeenCalledWith();
  });
});

describe('web backend', () => {
  beforeEach(() => {
    setUpMove('m-1');
    writeWebLabelSettings(settings());
  });
  afterEach(() => {
    // The web kiosk has no edge: not one /edge/* route, whatever it did.
    for (const fn of Object.values(apiMock)) expect(fn).not.toHaveBeenCalled();
  });

  describe('getLabel', () => {
    it('returns the stored label for the set-up move, kind and DPI', async () => {
      await putRows('labels', [row()]);
      expect(await webLabelBackend.getLabel('a-1')).toEqual({
        asset_id: 'a-1', zpl: '^XA^FDLABEL^FS^XZ', error: null, template_name: 'Vegas · 203', dpi: 203,
        label_kind: 'top',
      });
    });

    it("hands back a stored outcome so the queue can say why there's no label", async () => {
      await putRows('labels', [row({ zpl: null, error: 'template_unsupported' })]);
      expect(await webLabelBackend.getLabel('a-1')).toMatchObject({ zpl: null, error: 'template_unsupported' });
    });

    it('refuses while syncing', async () => {
      await putRows('labels', [row()]);
      syncState.phase = 'running';
      expect(await refusal(webLabelBackend.getLabel('a-1'))).toEqual({ status: 409, code: 'labels_syncing' });
    });

    it('refuses while building', async () => {
      await putRows('labels', [row()]);
      build.status = { ...build.status, state: 'running', reason: 'updates', total: 4, done: 1 };
      expect(await refusal(webLabelBackend.getLabel('a-1'))).toEqual({ status: 409, code: 'labels_regenerating' });
    });

    it('refuses a row built for another move', async () => {
      await putRows('labels', [row({ initiativeId: 'm-2' })]);
      expect(await refusal(webLabelBackend.getLabel('a-1'))).toEqual({ status: 404, code: 'label_not_found' });
    });

    it('refuses a row of another kind or DPI than the saved settings', async () => {
      await putRows('labels', [row({ label_kind: 'front' })]);
      expect(await refusal(webLabelBackend.getLabel('a-1'))).toEqual({ status: 404, code: 'label_not_found' });
      await putRows('labels', [row({ dpi: 300 })]);
      expect(await refusal(webLabelBackend.getLabel('a-1'))).toEqual({ status: 404, code: 'label_not_found' });
    });

    it('refuses an asset with no stored label, and any label with no move or no printer saved', async () => {
      expect(await refusal(webLabelBackend.getLabel('a-9'))).toEqual({ status: 404, code: 'label_not_found' });
      await putRows('labels', [row()]);
      localStorage.removeItem('ss.kiosk.labelPrinting');
      expect(await refusal(webLabelBackend.getLabel('a-1'))).toEqual({ status: 404, code: 'label_not_found' });
      writeWebLabelSettings(settings());
      localStorage.removeItem('ss.kiosk.setup');
      expect(await refusal(webLabelBackend.getLabel('a-1'))).toEqual({ status: 404, code: 'label_not_found' });
    });
  });

  it('recordPrinted queues a Labeled barcode scan with the exact scanned value', async () => {
    const id = await webLabelBackend.recordPrinted(job({ scannedValue: 'sn-4242' }));
    expect(typeof id).toBe('string');
    const queued = readOutbox().rows;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      // the moment it was scanned, not when its label finished printing
      scanned_at: '2026-11-04T10:00:00.000Z',
      client_scan_id: id, scanned_value: 'sn-4242', scan_type: 'barcode', scan_status: 'labeled',
      site_id: 's-1', initiative_id: 'm-1', matched: true, status: 'queued',
      asset: {
        id: 'a-1', asset_id: '10042', name: 'Rack 4 server', rfid: 'E200001', serial_number: 'SN-4242',
        make_model: 'Dell R640',
      },
    });
    // the outbox keeps the scan across a reload
    expect((await getAll<OutboxRow>('outbox')).map((r) => r.client_scan_id)).toEqual([id]);
  });

  it('recordedIds returns only accepted rows', async () => {
    const base = {
      seq: 1, scanned_value: '10042', scan_type: 'barcode', scanned_at: '2026-11-04T10:00:00.000Z',
      asset: null, matched: true, attempts: 0, site_id: 's-1', initiative_id: 'm-1', scan_status: 'labeled',
    };
    await putRows('outbox', [
      { ...base, client_scan_id: 'c-1', seq: 1, status: 'accepted' },
      { ...base, client_scan_id: 'c-2', seq: 2, status: 'queued' },
      { ...base, client_scan_id: 'c-3', seq: 3, status: 'retrying' },
      { ...base, client_scan_id: 'c-4', seq: 4, status: 'failed' },
    ]);
    await loadOutbox();
    expect(await webLabelBackend.recordedIds(['c-1', 'c-2', 'c-3', 'c-4', 'c-5'])).toEqual(['c-1']);
  });

  it("recordedIds sees a busy station's early scans, past the list's newest 200", async () => {
    const base = {
      scanned_value: '10042', scan_type: 'barcode', scanned_at: '2026-11-04T10:00:00.000Z', asset: null,
      matched: true, attempts: 0, site_id: 's-1', initiative_id: 'm-1', scan_status: 'labeled',
    };
    // c-1 (the oldest) accepted, then 250 newer scans still queued offline
    await putRows('outbox', [
      { ...base, client_scan_id: 'c-1', seq: 1, status: 'accepted' },
      ...Array.from({ length: 250 }, (_, i) => ({ ...base, client_scan_id: `q-${i}`, seq: i + 2, status: 'queued' })),
    ]);
    await loadOutbox();
    expect(readOutbox().rows.some((r) => r.client_scan_id === 'c-1')).toBe(false);
    expect(await webLabelBackend.recordedIds(['c-1', 'q-0', 'q-249'])).toEqual(['c-1']);
  });

  it('saveSettings forces USB and returns what was stored', async () => {
    const stored = await webLabelBackend.saveSettings(settings({
      label_kind: 'front', dpi: 300, offset_x: 7, offset_y: -3, peel: true,
      printer: { type: 'network', ip: '10.0.0.40', model: 'ZD621', serial: 'Z9' },
    }));
    const want = {
      label_kind: 'front', printer: { type: 'usb', ip: null, model: 'ZD621', serial: 'Z9' },
      dpi: 300, offset_x: 7, offset_y: -3, peel: true,
    };
    expect(stored).toEqual(want);
    expect(readWebLabelSettings()).toEqual(want);
    expect(await webLabelBackend.getSettings()).toEqual(want);
  });

  it('getSettings is null until a printer is saved', async () => {
    localStorage.removeItem('ss.kiosk.labelPrinting');
    expect(await webLabelBackend.getSettings()).toBeNull();
  });

  describe('getPlan', () => {
    beforeEach(async () => {
      await putRows('label_templates', [template(), template({ id: 't-2', name: 'Other', version: 1 })]);
      await writeMeta('label_templates', { initiativeId: 'm-1' });
    });

    it("names the picked template from this kiosk's stored template set", async () => {
      build.plan.mockResolvedValue(plan({
        templateId: 't-1', templateFamily: 'Vegas', notes: ['No destination template at 300 DPI.'],
        fonts: ['ROBOTO.TTF'],
      }));
      expect(await webLabelBackend.getPlan({ dpi: 300, kind: 'front' })).toEqual({
        template: { id: 't-1', name: 'Vegas · 300', family: 'Vegas', dpi_key: '300', version: 4 },
        notes: ['No destination template at 300 DPI.'], fonts: ['ROBOTO.TTF'], available_dpis: [],
      });
      expect(build.plan).toHaveBeenCalledWith({ dpi: 300, kind: 'front' });
    });

    it('a picked template missing from the stored set refuses the plan, so callers fall back', async () => {
      // only a sync landing between the plan's read and this one does it
      build.plan.mockResolvedValue(plan({ templateId: 't-gone', templateFamily: 'Gone' }));
      expect(await refusal(webLabelBackend.getPlan({ dpi: 300, kind: 'front' })))
        .toEqual({ status: 404, code: 'template_not_found' });
    });

    it('with no template picked, says at which DPIs the move has one', async () => {
      build.plan.mockResolvedValue(plan({ availableDpis: [300, 600] }));
      expect(await webLabelBackend.getPlan({ dpi: 203, kind: 'top' })).toEqual({
        template: null, notes: [], fonts: [], available_dpis: ['300', '600'],
      });
    });

    it('with the bodies not downloaded, refuses the plan so callers fall back', async () => {
      // an empty plan would read as "this move has no active template"
      build.plan.mockResolvedValue(null);
      expect(await refusal(webLabelBackend.getPlan({ dpi: 203, kind: 'top' })))
        .toEqual({ status: 409, code: 'labels_not_downloaded' });
    });

    it('defaults to the saved kind and DPI', async () => {
      writeWebLabelSettings(settings({ label_kind: 'front', dpi: 300 }));
      build.plan.mockResolvedValue(plan());
      await webLabelBackend.getPlan({});
      expect(build.plan).toHaveBeenCalledWith({ dpi: 300, kind: 'front' });
    });
  });

  it("getStatus is the browser build's status", async () => {
    build.status = { state: 'running', reason: 'updates', total: 9, done: 2, ready: 7, errors: 2, unsupported: 1 };
    expect(await webLabelBackend.getStatus()).toBe(build.status);
  });
});
