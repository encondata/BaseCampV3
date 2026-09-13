import { describe, expect, it } from 'vitest';

import {
  CALIBRATE, FACTORY_DEFAULTS, HOST_IDENTIFICATION, HOST_STATUS, PRINT_CONFIGURATION_LABEL, SAVE_SETTINGS,
  configurationQuery, deleteObject, directoryQuery, downloadFontHeader, dpiFromDotsPerMm, fontObjectName,
  isTrueType, setDarkness, setLabelSize, setMediaTracking, setPrintMethod, setPrintMode, setPrintSpeed,
} from './zebraCommands';

describe('command strings', () => {
  it('constants', () => {
    expect(HOST_IDENTIFICATION).toBe('~HI');
    expect(HOST_STATUS).toBe('~HS');
    expect(CALIBRATE).toBe('~JC');
    expect(PRINT_CONFIGURATION_LABEL).toBe('~WC');
    expect(SAVE_SETTINGS).toBe('^XA^JUS^XZ');
    expect(FACTORY_DEFAULTS).toBe('^XA^JUF^XZ');
  });
  it('queries and object commands', () => {
    expect(configurationQuery()).toBe('^XA^HH^XZ');
    expect(directoryQuery()).toBe('^XA^HWE:*.*^XZ');
    expect(directoryQuery('R')).toBe('^XA^HWR:*.*^XZ');
    expect(deleteObject('E', '85620388.TTF')).toBe('^XA^IDE:85620388.TTF^XZ');
    expect(downloadFontHeader('E', '85620388.TTF', 124336)).toBe('~DYE:85620388.TTF,B,T,124336,,');
  });
  it('settings with clamping', () => {
    expect(setDarkness(7)).toBe('~SD07');
    expect(setDarkness(30)).toBe('~SD30');
    expect(setDarkness(45)).toBe('~SD30');
    expect(setDarkness(-2)).toBe('~SD00');
    expect(setDarkness(12.6)).toBe('~SD13');
    expect(setDarkness(NaN)).toBe('~SD00');
    expect(setPrintSpeed(6)).toBe('^XA^PR6^XZ');
    expect(setPrintSpeed(1)).toBe('^XA^PR2^XZ');
    expect(setPrintSpeed(99)).toBe('^XA^PR14^XZ');
    expect(setPrintSpeed(NaN)).toBe('^XA^PR2^XZ');
    expect(setMediaTracking('W')).toBe('^XA^MNW^XZ');
    expect(setPrintMode('P')).toBe('^XA^MMP^XZ');
    expect(setPrintMethod('D')).toBe('^XA^MTD^XZ');
    expect(setLabelSize(812, 406)).toBe('^XA^PW812^LL406^XZ');
    // ^LL only applies to continuous media; gap/mark media omits it.
    expect(setLabelSize(812, null)).toBe('^XA^PW812^XZ');
  });
});

describe('font helpers', () => {
  it('validates Zebra 8.3 object names', () => {
    expect(fontObjectName('85620388.ttf')).toBe('85620388.TTF');
    expect(fontObjectName('/tmp/tt0003m_.TTF')).toBe('TT0003M_.TTF');
    expect(fontObjectName('longername.ttf')).toBeNull();
    expect(fontObjectName('a.otf')).toBeNull();
    expect(fontObjectName('bad name.ttf')).toBeNull();
    expect(fontObjectName('')).toBeNull();
  });
  it('sniffs TrueType magics', () => {
    expect(isTrueType(new Uint8Array([0, 1, 0, 0, 5]))).toBe(true);
    expect(isTrueType(new TextEncoder().encode('true\x00'))).toBe(true);
    expect(isTrueType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isTrueType(new Uint8Array([]))).toBe(false);
  });
  it('maps dots per mm to DPI', () => {
    expect(dpiFromDotsPerMm(6)).toBe(150);
    expect(dpiFromDotsPerMm(8)).toBe(203);
    expect(dpiFromDotsPerMm(12)).toBe(300);
    expect(dpiFromDotsPerMm(24)).toBe(600);
    expect(dpiFromDotsPerMm(10)).toBe(254);
  });
});
