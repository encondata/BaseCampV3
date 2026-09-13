import { describe, expect, it } from 'vitest';

import type { PrinterConfiguration } from './zebraUsb';
import { commandsForMedia, commandsForQuality, confirmMedia, confirmQuality, mediaChoicesFromConfig, qualityFromConfig } from './zebraSetup';

const cfg: PrinterConfiguration = {
  darkness: 10, printSpeed: 6, tearOff: 0, printMode: 'TEAR OFF', mediaType: 'GAP/NOTCH', printMethod: 'DIRECT-THERMAL',
  printWidth: 812, labelLength: 1218, firmware: 'V72', raw: {},
};

describe('media', () => {
  it('derives choices from the configuration', () => {
    expect(mediaChoicesFromConfig(cfg)).toEqual({ tracking: 'W', method: 'D', mode: 'T', widthDots: 812, lengthDots: 1218 });
    expect(mediaChoicesFromConfig({ ...cfg, mediaType: 'MARK', printMethod: 'THERMAL-TRANS.', printMode: 'PEEL OFF' })).toMatchObject({ tracking: 'M', method: 'T', mode: 'P' });
    expect(mediaChoicesFromConfig(null)).toEqual({ tracking: null, method: null, mode: null, widthDots: null, lengthDots: null });
  });
  it('emits only the commands for changed settings, in order', () => {
    const cur = mediaChoicesFromConfig(cfg);
    expect(commandsForMedia(cur, cur)).toEqual([]);
    expect(commandsForMedia(cur, { ...cur, tracking: 'N', mode: 'C', widthDots: 609, lengthDots: 406 }))
      .toEqual(['^XA^MNN^XZ', '^XA^MMC^XZ', '^XA^PW609^LL406^XZ']);
    expect(commandsForMedia(cur, { ...cur, method: 'T' })).toEqual(['^XA^MTT^XZ']);
  });
  it('confirms against a re-read configuration', () => {
    expect(confirmMedia(cfg, { tracking: 'W', method: 'D', mode: 'T', widthDots: 812, lengthDots: 1218 })).toEqual({ tracking: true, method: true, mode: true, size: true });
    expect(confirmMedia(cfg, { tracking: 'M', method: null, mode: 'C', widthDots: 609, lengthDots: 1218 })).toEqual({ tracking: false, method: null, mode: false, size: false });
    expect(confirmMedia(null, { tracking: 'W', method: 'D', mode: 'T', widthDots: 812, lengthDots: 1218 })).toEqual({ tracking: null, method: null, mode: null, size: null });
  });
  it('on gap/mark media, ^LL is never sent and confirm ignores label length', () => {
    const cur = mediaChoicesFromConfig(cfg); // tracking: 'W' (gap/notch)
    expect(commandsForMedia(cur, { ...cur, widthDots: 609 })).toEqual(['^XA^PW609^XZ']);
    expect(confirmMedia({ ...cfg, printWidth: 609, labelLength: 999 }, { ...cur, widthDots: 609 })).toMatchObject({ size: true });
  });
});

describe('quality', () => {
  it('derives, diffs, and confirms darkness/speed', () => {
    expect(qualityFromConfig(cfg)).toEqual({ darkness: 10, speed: 6 });
    expect(commandsForQuality({ darkness: 10, speed: 6 }, { darkness: 10, speed: 6 })).toEqual([]);
    expect(commandsForQuality({ darkness: 10, speed: 6 }, { darkness: 14, speed: 4 })).toEqual(['~SD14', '^XA^PR4^XZ']);
    expect(confirmQuality({ ...cfg, darkness: 14.0 }, { darkness: 14, speed: 6 })).toEqual({ darkness: true, speed: true });
    expect(confirmQuality(cfg, { darkness: 14, speed: null })).toEqual({ darkness: false, speed: null });
  });
});
