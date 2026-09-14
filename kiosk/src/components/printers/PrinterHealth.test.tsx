// @vitest-environment jsdom
/** Ported from portal/src/components/printers/PrinterHealth.test.tsx. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { HostStatus } from '@portal/labels/zebraUsb';
import PrinterHealth, { healthChips } from './PrinterHealth';

afterEach(cleanup);
const ok: HostStatus = {
  paperOut: false, paused: false, labelLength: 1218, formatsQueued: 0, bufferFull: false, partialFormat: false,
  corruptRam: false, underTemp: false, overTemp: false, headOpen: false, ribbonOut: false, thermalTransfer: false,
  printMode: '0', labelWaiting: false, labelsRemaining: 0,
};

describe('healthChips', () => {
  it('is a single green Ready chip when nothing is wrong', () => {
    expect(healthChips(ok)).toEqual([{ label: 'Ready', tone: 'c-green' }]);
  });
  it('lists every raised flag in red plus the queue in slate', () => {
    expect(healthChips({ ...ok, paperOut: true, headOpen: true, paused: true, overTemp: true, formatsQueued: 3 }).map((c) => c.label))
      .toEqual(['Paper out', 'Head open', 'Paused', 'Over temperature', '3 labels queued']);
    expect(healthChips({ ...ok, paused: true })[0].tone).toBe('c-amber');
    expect(healthChips({ ...ok, formatsQueued: 1 })).toEqual([{ label: 'Ready', tone: 'c-green' }, { label: '1 label queued', tone: 'c-slate' }]);
  });
  it('is empty without a status', () => { expect(healthChips(null)).toEqual([]); });
});

it('renders identity and health chips', () => {
  render(<PrinterHealth productName="ZD421" status={{ ...ok, ribbonOut: true }}
                       identity={{ model: 'ZD421-203dpi ZPL', firmware: 'V92.21.16Z', dotsPerMm: 8, memory: '8192KB', dpi: 203 }} />);
  expect(screen.getByText('ZD421-203dpi ZPL')).toBeTruthy();
  expect(screen.getByText('V92.21.16Z')).toBeTruthy();
  expect(screen.getByText('203 DPI')).toBeTruthy();
  expect(screen.getByText('8192KB')).toBeTruthy();
  expect(screen.getByText('Ribbon out')).toBeTruthy();
});
