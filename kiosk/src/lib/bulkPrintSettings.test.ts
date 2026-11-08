// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PRINT_SETTINGS, readPrintSettings } from '@portal/lib/printLabels';

import type { LabelStationSettings } from './api';
import {
  bulkSettingsModified, resetBulkSettings, stationZpl, writeBulkSettings,
} from './bulkPrintSettings';

const saved = (over: Partial<LabelStationSettings> = {}): LabelStationSettings => ({
  label_kind: 'top', printer: { type: 'usb', ip: null, model: null, serial: null },
  dpi: 203, offset_x: 8, offset_y: -3, peel: true, ...over,
});

describe('bulkPrintSettings', () => {
  beforeEach(() => localStorage.clear());

  it('the settings window keeps the stored offsets', () => {
    localStorage.setItem('labels.print.settings', JSON.stringify({
      verticalOffset: 12, horizontalOffset: -4, copies: 1, batchSize: 50, printByRack: false, blanksBetweenRacks: 1,
    }));
    writeBulkSettings({ ...DEFAULT_PRINT_SETTINGS, copies: 3 });
    const s = readPrintSettings();
    expect(s.verticalOffset).toBe(12);
    expect(s.horizontalOffset).toBe(-4);
    expect(s.copies).toBe(3);
  });

  it('offsets alone are not modified', () => {
    expect(bulkSettingsModified({ ...DEFAULT_PRINT_SETTINGS, verticalOffset: 12 })).toBe(false);
    expect(bulkSettingsModified({ ...DEFAULT_PRINT_SETTINGS, copies: 2 })).toBe(true);
  });

  it('reset keeps offsets', () => {
    const r = resetBulkSettings({
      verticalOffset: 5, horizontalOffset: 6, copies: 4, batchSize: 10, printByRack: true, blanksBetweenRacks: 3,
    });
    expect(r).toEqual({ ...DEFAULT_PRINT_SETTINGS, verticalOffset: 5, horizontalOffset: 6 });
  });

  it('stationZpl uses the saved offsets and print mode', () => {
    const z = stationZpl('^XA^FDA^FS^XZ', DEFAULT_PRINT_SETTINGS, saved());
    expect(z).toContain('^MMP');
    expect(z).toContain('^LS-8');
    expect(z).toContain('^LT-3');
    expect(stationZpl('^XA^FDA^FS^XZ', DEFAULT_PRINT_SETTINGS, saved({ peel: false }))).toContain('^MMT');
    const two = { ...DEFAULT_PRINT_SETTINGS, copies: 2 };
    expect(stationZpl('^XA^FDA^FS^XZ', two, saved(), { singleCopy: true })).not.toContain('^PQ2');
    expect(stationZpl('^XA^FDA^FS^XZ', two, saved())).toContain('^PQ2');
  });
});
