/**
 * One seam for everything label printing asks of the device it runs on, so
 * the Printing Station, the printer step, the test labels and the station
 * printer tools are the same screens on a laptop and on a web kiosk.
 *
 * - **Edge** (a laptop Label Station, `isLaptop()`): a thin pass-through to
 *   the `/edge/*` routes in `api.ts`, called with exactly the arguments the
 *   screens always used — the laptop behaves as it did before this seam.
 * - **Web** (every other kiosk): no edge exists, so each call has a local
 *   stand-in and none of them reaches an `/edge/*` route:
 *     - settings: `webLabelSettings.ts` (localStorage; always USB);
 *     - the plan: the shared generator's plan over the stored sync bodies
 *       (`requestLabelPlan`), named from the stored template set;
 *     - a label: the browser build's `labels` store — one IndexedDB read,
 *       no render, no wait (no status check is made per label);
 *     - a printed label's Labeled scan: the existing scan outbox, exactly as
 *       Scanning queues a scan, so it reaches the portal when online;
 *     - recorded?: that outbox row reached `accepted`;
 *     - status: the browser build's status (`LabelRunStatus` shape).
 *
 * `deviceWord` is what copy calls the device ("this laptop" / "this
 * kiosk"); `printerTypes` is what the printer step offers (a browser has
 * WebUSB only; the network transport is the edge's).
 */

import {
  ApiError, getLabelPlan, getLabelRunStatus, getLabelStation, getRecordedScans, getStationLabel,
  postLabelPrinted, putLabelStation,
  type LabelKind, type LabelPlan, type LabelPlanTemplate, type LabelRunStatus, type LabelStationSettings,
  type StationLabel,
} from './api';
import { readKioskSetup } from './kioskSetup';
import { getLabelTemplates } from './labelTemplates';
import { getRow } from './localDb';
import { enqueueScan, readOutbox } from './outbox';
import { isLaptop } from './platform';
import type { DeviceWord, PrintedJob } from './printQueue';
import { readSyncStatus } from './sync';
import { readWebLabelKind, readWebLabelSettings, writeWebLabelSettings } from './webLabelSettings';
import { readWebLabelStatus, requestLabelPlan, type WebLabelRow } from './webLabels/labelBuild';

export type PrinterType = LabelStationSettings['printer']['type'];

export interface LabelBackend {
  kind: 'edge' | 'web';
  deviceWord: DeviceWord;
  printerTypes: readonly PrinterType[];
  /** The saved settings, or null when no printer is saved. */
  getSettings(): Promise<LabelStationSettings | null>;
  /** Saves them and resolves to what was stored. */
  saveSettings(s: LabelStationSettings): Promise<LabelStationSettings>;
  /** The template the station prints with at `dpi` / `kind` (the saved
   *  settings' when left out). */
  getPlan(opts: { dpi?: number; kind?: LabelKind }): Promise<LabelPlan>;
  /** The asset's finished label. Throws ApiError `label_not_found` (404),
   *  or 409 `labels_regenerating` / `labels_syncing` (web) while the
   *  stored labels are being replaced. */
  getLabel(assetId: string): Promise<StationLabel>;
  /** Queues the printed label's Labeled scan; its client_scan_id. */
  recordPrinted(job: PrintedJob): Promise<string | null>;
  /** Which of these Labeled scans the portal has accepted. */
  recordedIds(ids: string[]): Promise<string[]>;
  getStatus(): Promise<LabelRunStatus>;
}

// ── the laptop ──────────────────────────────────────────────────────

export const edgeLabelBackend: LabelBackend = {
  kind: 'edge',
  deviceWord: 'laptop',
  printerTypes: ['usb', 'network'],
  getSettings: () => getLabelStation(),
  saveSettings: (s) => putLabelStation(s),
  getPlan: (opts) => getLabelPlan(opts),
  getLabel: (assetId) => getStationLabel(assetId),
  recordPrinted: (job) => postLabelPrinted({
    asset_id: job.assetId, scanned_value: job.scannedValue, scanned_at: job.scannedAt,
  }),
  recordedIds: (ids) => getRecordedScans(ids),
  getStatus: () => getLabelRunStatus(),
};

// ── the web kiosk ───────────────────────────────────────────────────

/** What the edge answers when the move's set has nothing to pick from. */
const NO_PLAN: LabelPlan = { template: null, notes: [], fonts: [], available_dpis: [] };

/** The picked template as the edge names it, from the stored template set
 *  (the plan carries only its id and family). The parsed set and the raw
 *  body the plan read are written in one sync transaction, so the row is
 *  there; only a sync landing between the two reads can take it away, and
 *  then the plan is refused like an edge that didn't answer (the printer
 *  step and the test labels fall back to the downloaded templates). */
async function planTemplate(id: string, family: string | null, dpi: number): Promise<LabelPlanTemplate> {
  const stored = (await getLabelTemplates()).find((t) => t.id === id);
  if (!stored) throw new ApiError(404, 'template_not_found');
  return {
    id, name: stored.name, family: stored.family ?? family ?? '', dpi_key: String(dpi), version: stored.version,
  };
}

export const webLabelBackend: LabelBackend = {
  kind: 'web',
  deviceWord: 'kiosk',
  printerTypes: ['usb'],

  getSettings: async () => readWebLabelSettings(),

  saveSettings: async (s) => writeWebLabelSettings(s),

  async getPlan(opts) {
    const saved = readWebLabelSettings();
    const dpi = opts.dpi ?? saved?.dpi;
    const kind = opts.kind ?? saved?.label_kind ?? readWebLabelKind();
    if (dpi === undefined) return NO_PLAN;
    // null: the bodies aren't downloaded for the set-up move yet
    const plan = await requestLabelPlan({ dpi, kind });
    if (plan === null) return NO_PLAN;
    return {
      template: plan.templateId === null ? null : await planTemplate(plan.templateId, plan.templateFamily, dpi),
      notes: plan.notes,
      fonts: plan.fonts,
      available_dpis: plan.availableDpis.map(String),
    };
  },

  async getLabel(assetId) {
    // A sync is replacing the bodies the labels come from, and a build is
    // replacing the labels: refuse rather than print what is being replaced.
    if (readSyncStatus().phase === 'running') throw new ApiError(409, 'labels_syncing');
    if (readWebLabelStatus().state === 'running') throw new ApiError(409, 'labels_regenerating');
    const row = await getRow<WebLabelRow>('labels', assetId);
    // Only a label made for this move, kind and DPI. A build can leave rows
    // of another move, kind or DPI in place (one whose assets body has no
    // usable data prunes nothing), and a re-set-up kiosk keeps the previous
    // move's until its next build: none of those may ever print.
    const settings = readWebLabelSettings();
    const moveId = readKioskSetup()?.initiativeId ?? '';
    if (row === null || settings === null || moveId === '' || row.initiativeId !== moveId
        || row.label_kind !== settings.label_kind || row.dpi !== settings.dpi) {
      throw new ApiError(404, 'label_not_found');
    }
    return {
      asset_id: row.asset_id, zpl: row.zpl, error: row.error, template_name: row.template_name,
      dpi: row.dpi, label_kind: row.label_kind,
    };
  },

  async recordPrinted(job) {
    const setup = readKioskSetup();
    // The Printing Station can't scan without a set-up move; this is only
    // a guard against queuing a scan for no site.
    if (!setup?.initiativeId || !setup.siteId) throw new ApiError(409, 'no_move');
    const { asset } = job;
    const row = await enqueueScan({
      scanned_value: job.scannedValue,
      scan_type: 'barcode',
      asset: {
        id: asset.id, asset_id: asset.asset_id, name: asset.name, rfid: asset.rfid,
        serial_number: asset.serial_number, make_model: asset.make_model,
      },
      site_id: setup.siteId,
      initiative_id: setup.initiativeId,
      scan_status: 'labeled',
    });
    return row.client_scan_id;
  },

  async recordedIds(ids) {
    const accepted = new Set(readOutbox().rows
      .filter((r) => r.status === 'accepted').map((r) => r.client_scan_id));
    return ids.filter((id) => accepted.has(id));
  },

  getStatus: async () => readWebLabelStatus(),
};

/** The backend for this device: the edge on a laptop, the web one elsewhere. */
export function labelBackend(): LabelBackend {
  return isLaptop() ? edgeLabelBackend : webLabelBackend;
}
