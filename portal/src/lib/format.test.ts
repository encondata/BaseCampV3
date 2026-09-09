import { describe, expect, it } from 'vitest';

import { displayRfid, displayScanValue } from './format';

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
