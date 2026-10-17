import { describe, expect, it } from 'vitest';

import { ageText, displayRfid, displayScanValue, fullDateTime, generateTempPassword } from './format';

describe('displayRfid', () => {
  it('drops the zero padding of an EPC', () => {
    expect(displayRfid('000000000000000000100418')).toBe('100418');
    expect(displayRfid('0A12')).toBe('A12');
  });
  it('leaves unpadded tags alone and keeps at least one character', () => {
    expect(displayRfid('ABC123')).toBe('ABC123');
    expect(displayRfid('100418')).toBe('100418');
    expect(displayRfid('0000')).toBe('0');
    expect(displayRfid('0')).toBe('0');
  });
  it('renders a missing tag as the dash', () => {
    expect(displayRfid(null)).toBe('—');
    expect(displayRfid(undefined)).toBe('—');
    expect(displayRfid('')).toBe('—');
  });
});

describe('displayScanValue', () => {
  it('trims only rfid reads', () => {
    expect(displayScanValue('000012', 'rfid')).toBe('12');
    expect(displayScanValue('000012', 'barcode')).toBe('000012');
    expect(displayScanValue('000012', 'manual')).toBe('000012');
    expect(displayScanValue('000012', null)).toBe('000012');
  });
});

describe('generateTempPassword', () => {
  it('is 14 characters by default and takes a length', () => {
    expect(generateTempPassword()).toHaveLength(14);
    expect(generateTempPassword(22)).toHaveLength(22);
  });

  it('uses the unambiguous alphabet and ends in a symbol', () => {
    expect(generateTempPassword(30)).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]{29}!$/);
  });
});

describe('ageText', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it('says how long ago, without "ago", in whole units', () => {
    expect(ageText(ago(20_000), now)).toBe('just now');
    expect(ageText(ago(60_000), now)).toBe('1 minute');
    expect(ageText(ago(5 * 60_000), now)).toBe('5 minutes');
    expect(ageText(ago(59 * 60_000), now)).toBe('59 minutes');
    expect(ageText(ago(3600_000), now)).toBe('1 hour');
    expect(ageText(ago(3 * 3600_000 + 40 * 60_000), now)).toBe('3 hours');
    expect(ageText(ago(24 * 3600_000), now)).toBe('1 day');
    expect(ageText(ago(30 * 24 * 3600_000), now)).toBe('30 days');
  });
  it('handles never and future times', () => {
    expect(ageText(null, now)).toBe('never');
    expect(ageText(new Date(now + 90_000).toISOString(), now)).toBe('just now');
  });
});

describe('fullDateTime', () => {
  it('is the local date and time, or never', () => {
    expect(fullDateTime('2026-10-17T12:00:00Z')).toBe(new Date('2026-10-17T12:00:00Z').toLocaleString());
    expect(fullDateTime(null)).toBe('never');
  });
});
