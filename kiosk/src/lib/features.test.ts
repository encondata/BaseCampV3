import { expect, it } from 'vitest';

import { FEATURES, featureAvailable } from './features';

const setup = FEATURES.find((f) => f.id === 'setup')!;
const settings = FEATURES.find((f) => f.id === 'settings')!;
const scan = FEATURES.find((f) => f.id === 'scan')!;
const enroll = FEATURES.find((f) => f.id === 'enroll')!;
const labels = FEATURES.find((f) => f.id === 'labels')!;
const timeclock = FEATURES.find((f) => f.id === 'timeclock')!;

it('setup and settings are always available, regardless of setup state', () => {
  for (const state of ['incomplete', 'complete', 'failed'] as const) {
    expect(featureAvailable(setup, state)).toBe(true);
    expect(featureAvailable(settings, state)).toBe(true);
  }
});

it('every other feature is unavailable until setup is complete', () => {
  for (const feature of [scan, enroll, labels, timeclock]) {
    expect(featureAvailable(feature, 'incomplete')).toBe(false);
    expect(featureAvailable(feature, 'failed')).toBe(false);
    expect(featureAvailable(feature, 'complete')).toBe(true);
  }
});

it('developer mode overrides the setup gate for every feature, in every setup state', () => {
  for (const state of ['incomplete', 'complete', 'failed'] as const) {
    for (const feature of [setup, settings, scan, enroll, labels, timeclock]) {
      expect(featureAvailable(feature, state, true)).toBe(true);
    }
  }
});

it('developer mode defaults to off when omitted', () => {
  expect(featureAvailable(scan, 'incomplete')).toBe(false);
});

it('RFID Enroll sits immediately after Scanning, with its own route', () => {
  const ids = FEATURES.map((f) => f.id);
  expect(ids.indexOf('enroll')).toBe(ids.indexOf('scan') + 1);
  expect(enroll.path).toBe('/enroll');
  expect(enroll.title).toBe('RFID Enroll');
  expect(enroll.placeholder).toBeUndefined();
});
