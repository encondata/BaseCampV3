// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { LabelStationSettings } from './api';
import {
  readWebLabelKind, readWebLabelSettings, subscribeWebLabelSettings, useWebLabelSettings,
  writeWebLabelKind, writeWebLabelSettings,
} from './webLabelSettings';

const KEY = 'ss.kiosk.labelPrinting';

const SETTINGS: LabelStationSettings = {
  label_kind: 'front',
  printer: { type: 'usb', ip: null, model: 'ZD421', serial: 'D4J123456' },
  dpi: 300, offset_x: 12, offset_y: -4, peel: true,
};

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

it('the label kind defaults to top', () => {
  expect(readWebLabelKind()).toBe('top');
  expect(readWebLabelSettings()).toBeNull();
});

it('a saved kind reads back, and with no printer saved the settings are still null', () => {
  writeWebLabelKind('front');
  expect(readWebLabelKind()).toBe('front');
  expect(readWebLabelSettings()).toBeNull();
  writeWebLabelKind('top');
  expect(readWebLabelKind()).toBe('top');
});

it('written settings round-trip, and write returns what it stored', () => {
  const stored = writeWebLabelSettings(SETTINGS);
  expect(stored).toEqual(SETTINGS);
  expect(readWebLabelSettings()).toEqual(SETTINGS);
  expect(readWebLabelKind()).toBe('front');
});

it('a written network printer comes back as a USB printer with no address', () => {
  const stored = writeWebLabelSettings({
    ...SETTINGS,
    printer: { type: 'network', ip: '10.0.0.7', model: 'ZT411', serial: 'X1' },
  });
  expect(stored.printer).toEqual({ type: 'usb', ip: null, model: 'ZT411', serial: 'X1' });
  expect(readWebLabelSettings()?.printer).toEqual(stored.printer);
  expect(localStorage.getItem(KEY)).not.toContain('10.0.0.7');
});

it('offsets are stored as whole dots', () => {
  const stored = writeWebLabelSettings({ ...SETTINGS, offset_x: 3.6, offset_y: -2.4 });
  expect(stored).toMatchObject({ offset_x: 4, offset_y: -2 });
  expect(readWebLabelSettings()).toMatchObject({ offset_x: 4, offset_y: -2 });
});

it('changing only the kind keeps the saved printer and moves the settings\' kind with it', () => {
  writeWebLabelSettings(SETTINGS);
  writeWebLabelKind('top');
  expect(readWebLabelKind()).toBe('top');
  expect(readWebLabelSettings()).toEqual({ ...SETTINGS, label_kind: 'top' });
});

it('settings written after a kind carry the kind they were given', () => {
  writeWebLabelKind('front');
  writeWebLabelSettings({ ...SETTINGS, label_kind: 'top' });
  expect(readWebLabelKind()).toBe('top');
});

it('printer settings need a positive whole-number dpi to count as saved', () => {
  const stored = (dpi: unknown) => JSON.stringify({
    label_kind: 'front', printer: { model: 'ZD421', serial: 'S' }, dpi,
  });
  for (const dpi of [0, -203, 203.5, '203', null, undefined]) {
    localStorage.setItem(KEY, stored(dpi));
    expect(readWebLabelSettings(), String(dpi)).toBeNull();
    expect(readWebLabelKind()).toBe('front');
  }
  localStorage.setItem(KEY, stored(203));
  expect(readWebLabelSettings()).toEqual({
    label_kind: 'front', printer: { type: 'usb', ip: null, model: 'ZD421', serial: 'S' },
    dpi: 203, offset_x: 0, offset_y: 0, peel: false,
  });
});

it('a stored value of the wrong shape reads as the defaults without throwing', () => {
  const garbage = [
    '{not json', 'null', '7', '"top"', '[]', '{}',
    JSON.stringify({ label_kind: 'sideways', printer: 'zebra', dpi: 203 }),
    JSON.stringify({ label_kind: 'front', printer: null, dpi: 203 }),
    JSON.stringify({ label_kind: 'front', printer: [], dpi: 203 }),
  ];
  for (const raw of garbage) {
    localStorage.setItem(KEY, raw);
    expect(readWebLabelSettings(), raw).toBeNull();
    expect(['top', 'front']).toContain(readWebLabelKind());
  }
  localStorage.setItem(KEY, '{not json');
  expect(readWebLabelKind()).toBe('top');
  localStorage.setItem(KEY, JSON.stringify({ label_kind: 'sideways' }));
  expect(readWebLabelKind()).toBe('top');
});

it('a kind written over garbage starts the record fresh', () => {
  localStorage.setItem(KEY, '{not json');
  writeWebLabelKind('front');
  expect(readWebLabelKind()).toBe('front');
});

it('blocked storage reads the defaults and writes do not throw', () => {
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  try {
    expect(readWebLabelKind()).toBe('top');
    expect(readWebLabelSettings()).toBeNull();
    expect(() => writeWebLabelKind('front')).not.toThrow();
    expect(writeWebLabelSettings(SETTINGS)).toEqual(SETTINGS);
  } finally {
    setItem.mockRestore();
    getItem.mockRestore();
  }
});

it('subscribers hear every write, and stop hearing after they unsubscribe', () => {
  const heard = vi.fn();
  const off = subscribeWebLabelSettings(heard);
  writeWebLabelKind('front');
  expect(heard).toHaveBeenCalledTimes(1);
  writeWebLabelSettings(SETTINGS);
  expect(heard).toHaveBeenCalledTimes(2);
  off();
  writeWebLabelKind('top');
  expect(heard).toHaveBeenCalledTimes(2);
});

it('useWebLabelSettings follows the saved settings and hands back a stable snapshot', () => {
  const { result, rerender } = renderHook(() => useWebLabelSettings());
  expect(result.current).toBeNull();

  act(() => { writeWebLabelSettings(SETTINGS); });
  expect(result.current).toEqual(SETTINGS);

  const snapshot = result.current;
  rerender();
  expect(result.current).toBe(snapshot);

  act(() => { writeWebLabelKind('top'); });
  expect(result.current).toEqual({ ...SETTINGS, label_kind: 'top' });
});
