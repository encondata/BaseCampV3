/** Bulk Print's settings window: copies, batch size, print by rack and
 *  blanks. The offsets belong to PrinterTools and the Printing Station. */
import {
  applyPrintSettings, DEFAULT_PRINT_SETTINGS, readPrintSettings, settingsModified,
  writePrintSettings, type PrintSettings,
} from '@portal/lib/printLabels';

import type { LabelStationSettings } from './api';
import { withPrintMode } from './stationPrinter';

/** Stored offsets never light the "modified" dot. */
export function bulkSettingsModified(s: PrintSettings): boolean {
  return settingsModified({ ...s, verticalOffset: 0, horizontalOffset: 0 });
}

/** Saves the four Bulk Print fields; the stored offsets survive. */
export function writeBulkSettings(s: PrintSettings): void {
  const { copies, batchSize, printByRack, blanksBetweenRacks } = s;
  writePrintSettings({ ...readPrintSettings(), copies, batchSize, printByRack, blanksBetweenRacks });
}

export function resetBulkSettings(s: PrintSettings): PrintSettings {
  const { copies, batchSize, printByRack, blanksBetweenRacks } = DEFAULT_PRINT_SETTINGS;
  return { ...s, copies, batchSize, printByRack, blanksBetweenRacks };
}

/** The Printing Station's offsets and print mode applied to a label's ZPL. */
export function stationZpl(
  zpl: string, s: PrintSettings, saved: LabelStationSettings, opts?: { singleCopy?: boolean },
): string {
  return withPrintMode(
    applyPrintSettings(zpl, { ...s, horizontalOffset: saved.offset_x, verticalOffset: saved.offset_y }, opts),
    saved.peel,
  );
}
