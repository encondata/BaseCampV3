/**
 * The Printing Station's print queue: scans that arrive while a label is
 * being sent wait their turn, and every job runs strictly one at a time in
 * arrival order.
 *
 * One job: the asset's stored label from the edge → the label with the
 * saved offsets and the saved peel or tear mode, sent straight to the
 * printer → a Labeled scan recorded with the exact value scanned, once per
 * scan on its first label that goes out (its first attempt or a Retry; a
 * Reprint never records).
 *
 * No status checks before or after a label (Jimmy): in peel mode the
 * printer itself holds the next label until this one is taken.
 *
 * A failed record doesn't undo the print: the entry stays printed with a
 * small warning, and nothing is printed again. Retry resends the very
 * same ZPL the failed attempt built (or fetches the label when it never
 * got that far).
 */

import { applyPrintSettings, DEFAULT_PRINT_SETTINGS } from '@portal/lib/printLabels';

import { ApiError, type LabelStationSettings, type StationLabel } from './api';
import type { ScanAsset } from './scanMatch';
import { withPrintMode, type StationPrinter } from './stationPrinter';

/** A roster asset; `label` is the sync's placeholder map (rack and RU). */
export type PrintAsset = ScanAsset & { label?: Record<string, string> };

export type EntryState = 'queued' | 'printing' | 'printed' | 'failed';

export interface QueueEntry {
  id: string;
  /** Null when the scanned value isn't on this move. */
  asset: PrintAsset | null;
  scannedValue: string;
  scannedAt: string;
  /** A Reprint of an earlier entry: it never records a scan. */
  reprint: boolean;
  state: EntryState;
  /** Why it failed. */
  message: string | null;
  /** Printed, but the Labeled scan couldn't be recorded. */
  recordWarning: string | null;
}

/** Newest first. */
export interface QueueState { entries: QueueEntry[] }

export interface PrintedJob { assetId: string; scannedValue: string; scannedAt: string }

export interface PrintQueueDeps {
  printer: () => StationPrinter | null;
  settings: () => LabelStationSettings | null;
  getLabel: (assetId: string) => Promise<StationLabel>;
  recordPrinted: (job: PrintedJob) => Promise<void>;
  onChange: (s: QueueState) => void;
  /** An entry just finished, printed or failed (the page's flash and sound). */
  onSettled?: (entry: QueueEntry) => void;
}

export interface PrintQueue {
  enqueue(job: { asset: PrintAsset | null; scannedValue: string }): void;
  reprint(entryId: string): void;
  retry(entryId: string): void;
}

export const NOT_ON_MOVE_TEXT = "This asset isn't on this move.";
export const PRINTER_SILENT_TEXT = "The printer didn't answer. Check that it's on and connected.";
export const REGENERATING_TEXT = 'Labels are being regenerated. Scan again when it finishes.';
export const NO_SETTINGS_TEXT = "This station's printer settings couldn't be read. Open Kiosk Setup.";

const LABEL_REASONS: Record<string, string> = {
  no_template_at_dpi: "no template at this printer's DPI",
  template_failed: "the label template couldn't be built",
};

export function noLabelText(reason: string | null): string {
  const why = reason ? (LABEL_REASONS[reason] ?? reason) : 'none was generated for it';
  return `No label for this asset: ${why}`;
}

function labelErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'labels_regenerating') return REGENERATING_TEXT;
    if (err.code === 'label_not_found') return noLabelText(null);
    return `Couldn't read this asset's label: ${err.code}`;
  }
  return "Couldn't read this asset's label: the laptop didn't answer.";
}

const RECORD_REASONS: Record<string, string> = {
  scan_value_mismatch: "the scanned value isn't this asset's ID or serial",
  label_not_found: 'this station has no finished label for the asset',
  not_label_station: "this laptop isn't set up as a Label Station",
};

function recordWarningText(err: unknown): string {
  const why = err instanceof ApiError ? (RECORD_REASONS[err.code] ?? err.code) : "the laptop didn't answer";
  return `Printed, but the scan wasn't recorded: ${why}`;
}

/** Per entry: the finished ZPL its last attempt built, and whether its
 *  Labeled scan was recorded. */
interface Work { entry: QueueEntry; sent: string | null; recorded: boolean }

export function createPrintQueue(deps: PrintQueueDeps): PrintQueue {
  const entries: QueueEntry[] = [];        // newest first
  const work = new Map<string, Work>();
  const pending: string[] = [];             // entry ids, arrival order
  let running = false;
  let nextId = 0;

  const emit = () => deps.onChange({ entries: entries.map((e) => ({ ...e })) });

  const update = (entry: QueueEntry, patch: Partial<QueueEntry>) => {
    Object.assign(entry, patch);
    emit();
    if (patch.state === 'printed' || patch.state === 'failed') deps.onSettled?.({ ...entry });
  };

  const add = (asset: PrintAsset | null, scannedValue: string, reprint: boolean): QueueEntry => {
    nextId += 1;
    const entry: QueueEntry = {
      id: `p-${nextId}`, asset, scannedValue, scannedAt: new Date().toISOString(), reprint,
      state: 'queued', message: null, recordWarning: null,
    };
    entries.unshift(entry);
    work.set(entry.id, { entry, sent: null, recorded: false });
    return entry;
  };

  async function run(w: Work): Promise<void> {
    const { entry } = w;
    if (!entry.asset) {
      update(entry, { state: 'failed', message: NOT_ON_MOVE_TEXT });
      return;
    }
    update(entry, { state: 'printing', message: null });
    const settings = deps.settings();
    if (!settings) {
      update(entry, { state: 'failed', message: NO_SETTINGS_TEXT });
      return;
    }
    if (w.sent === null) {
      let label: StationLabel;
      try {
        label = await deps.getLabel(entry.asset.id);
      } catch (err) {
        update(entry, { state: 'failed', message: labelErrorText(err) });
        return;
      }
      if (!label.zpl) {
        update(entry, { state: 'failed', message: noLabelText(label.error) });
        return;
      }
      w.sent = withPrintMode(applyPrintSettings(label.zpl, {
        ...DEFAULT_PRINT_SETTINGS,
        horizontalOffset: settings.offset_x,
        verticalOffset: settings.offset_y,
      }, { singleCopy: true }), settings.peel);
    }
    const printer = deps.printer();
    if (!printer) {
      update(entry, { state: 'failed', message: PRINTER_SILENT_TEXT });
      return;
    }
    try {
      await printer.send(w.sent);
    } catch {
      update(entry, { state: 'failed', message: PRINTER_SILENT_TEXT });
      return;
    }
    // A scan records once, on its first label that goes out (a failed
    // print recorded nothing, so its Retry does); a Reprint never does.
    if (!entry.reprint && !w.recorded) {
      w.recorded = true;
      try {
        await deps.recordPrinted({
          assetId: entry.asset.id, scannedValue: entry.scannedValue, scannedAt: entry.scannedAt,
        });
      } catch (err) {
        entry.recordWarning = recordWarningText(err);
      }
    }
    update(entry, { state: 'printed' });
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (let id = pending.shift(); id !== undefined; id = pending.shift()) {
        const w = work.get(id);
        if (w) await run(w);
      }
    } finally {
      running = false;
    }
  }

  const schedule = (entry: QueueEntry) => {
    pending.push(entry.id);
    void pump();
  };

  return {
    enqueue({ asset, scannedValue }) {
      const entry = add(asset, scannedValue, false);
      if (!asset) {
        // Nothing to print, so it doesn't wait behind the queue.
        update(entry, { state: 'failed', message: NOT_ON_MOVE_TEXT });
        return;
      }
      emit();
      schedule(entry);
    },
    reprint(entryId) {
      const source = work.get(entryId)?.entry;
      if (!source?.asset) return;
      const entry = add(source.asset, source.scannedValue, true);
      emit();
      schedule(entry);
    },
    retry(entryId) {
      const w = work.get(entryId);
      if (!w || w.entry.state !== 'failed' || !w.entry.asset) return;
      update(w.entry, { state: 'queued', message: null });
      schedule(w.entry);
    },
  };
}
