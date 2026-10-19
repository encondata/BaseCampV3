import { describe, expect, it } from 'vitest';

import type { DeviceConfigHistoryItem } from './api';
import {
  DEFAULT_CONFIG, applicableSections, configFor, labelStationOf, sectionSource, soundLabel, syncLine, withSection,
} from './kioskConfig';

const NOW = Date.parse('2026-10-17T12:00:00Z');

describe('withSection', () => {
  it('replaces only the named section and keeps every other one, unknown ones included', () => {
    const base = {
      ...DEFAULT_CONFIG,
      android_rfid: { power: 270 },
      future: { x: [1, 2] },
    };
    const next = withSection(base, 'appearance', { ...DEFAULT_CONFIG.appearance, flash_ms: 600 });
    expect(next).toEqual({
      ...base,
      appearance: { ...DEFAULT_CONFIG.appearance, flash_ms: 600 },
    });
    // the input is not mutated
    expect((base.appearance as { flash_ms: number }).flash_ms).toBe(350);
  });

  it('starts from the defaults when the kiosk has no stored config', () => {
    expect(configFor(null)).toEqual(DEFAULT_CONFIG);
    expect(configFor(null)).not.toBe(DEFAULT_CONFIG);
  });
});

describe('syncLine', () => {
  it('reads each of the three states', () => {
    expect(syncLine({ sync_state: 'in_sync', config_changed_at: null }, NOW)).toBe('In sync');
    expect(syncLine({
      sync_state: 'pending', config_changed_at: '2026-10-17T11:55:00Z',
    }, NOW)).toBe('Pending on kiosk · 5 minutes');
    expect(syncLine({ sync_state: 'waiting_first_report', config_changed_at: null }, NOW))
      .toBe('Waiting for first report');
  });
});

describe('sectionSource', () => {
  const history: DeviceConfigHistoryItem[] = [
    { at: '2026-10-17T10:00:00Z', source: 'portal', version: 3, by_name: 'Jimmy Henderson',
      changes: { 'appearance.flash_ms': { from: 350, to: 600 } } },
    { at: '2026-10-16T12:00:00Z', source: 'kiosk', version: 2, by_name: null,
      changes: { 'sound.volume': { from: 0.8, to: 0.5 }, 'appearance.flash_ms': { from: 300, to: 350 } } },
  ];
  it('names the newest change that touched the section', () => {
    expect(sectionSource('appearance', history, NOW))
      .toBe('changed on the portal by Jimmy Henderson · 2 hours ago');
    expect(sectionSource('sound', history, NOW)).toBe('changed on the kiosk · 1 day ago');
  });
  it('says so when no recorded change touched it', () => {
    expect(sectionSource('checkpoints', history, NOW)).toBe('No changes recorded');
  });
});

describe('applicableSections', () => {
  it('adds the alarm only on a laptop RFID Station and platform sections on their platforms', () => {
    const core = ['appearance', 'sound', 'checkpoints', 'developer'];
    expect(applicableSections({ sub_type: 'web', station_type: null })).toEqual(core);
    expect(applicableSections({ sub_type: 'laptop', station_type: 'label' })).toEqual(core);
    expect(applicableSections({ sub_type: 'laptop', station_type: 'rfid' })).toEqual([...core, 'alarm']);
    expect(applicableSections({ sub_type: 'zebra', station_type: null })).toEqual([...core, 'android_rfid']);
    expect(applicableSections({ sub_type: 'ios', station_type: null })).toEqual([...core, 'ios']);
  });
});

describe('soundLabel', () => {
  const sounds = [{ id: 'u1', name: 'ding.mp3' }];
  it('names built-ins, uploads, none and the siren', () => {
    expect(soundLabel({ kind: 'builtin', id: 'double_beep' }, sounds)).toBe('Double beep');
    expect(soundLabel({ kind: 'upload', id: 'u1' }, sounds)).toBe('ding.mp3');
    expect(soundLabel({ kind: 'upload', id: 'gone' }, sounds)).toBe('Uploaded sound (missing)');
    expect(soundLabel({ kind: 'none' }, sounds)).toBe('None');
    expect(soundLabel({ kind: 'siren' }, sounds)).toBe('Siren');
  });
});

describe('sectionSource at the history cap', () => {
  it('says unchanged in the last 200 when a full page never touches the section', () => {
    const full: DeviceConfigHistoryItem[] = Array.from({ length: 200 }, (_, i) => ({
      at: '2026-10-17T10:00:00Z', source: 'kiosk', version: 200 - i, by_name: null,
      changes: { 'sound.volume': { from: 0.5, to: 0.6 } },
    }));
    expect(sectionSource('appearance', full, NOW)).toBe('Unchanged in the last 200 changes');
    expect(sectionSource('appearance', full.slice(0, 199), NOW)).toBe('No changes recorded');
  });
});

describe('label_station', () => {
  const ls = {
    label_kind: 'top',
    printer: { type: 'usb', ip: null, model: 'ZD621', serial: null },
    dpi: 203, offset_x: 0, offset_y: 0,
  };

  it('is read when present and hidden when absent, null or malformed', () => {
    expect(labelStationOf({ ...DEFAULT_CONFIG, label_station: ls })).toEqual(ls);
    expect(labelStationOf(DEFAULT_CONFIG)).toBeNull();
    expect(labelStationOf({ ...DEFAULT_CONFIG, label_station: null })).toBeNull();
    expect(labelStationOf({ ...DEFAULT_CONFIG, label_station: 'x' })).toBeNull();
  });

  it('passes through withSection byte for byte', () => {
    const base = { ...DEFAULT_CONFIG, label_station: ls };
    const next = withSection(base, 'sound', { ...DEFAULT_CONFIG.sound, volume: 0.5 });
    expect(JSON.stringify(next.label_station)).toBe(JSON.stringify(ls));
    const nulled = withSection({ ...DEFAULT_CONFIG, label_station: null }, 'sound', DEFAULT_CONFIG.sound);
    expect(nulled.label_station).toBeNull();
  });

  it('is not an editable section', () => {
    expect(applicableSections({ sub_type: 'laptop', station_type: 'label' }))
      .not.toContain('label_station' as never);
  });
});
