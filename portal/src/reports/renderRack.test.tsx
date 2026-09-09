// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { renderRackSvg } from './renderRack';

const row = (over: Record<string, unknown>) => ({
  id: 'r1', source_rack: 'R1', source_ru: 10, source_verified: true, source_position: null,
  destination_rack: null, destination_ru: null, destination_verified: null,
  destination_position: null,
  asset: { name: 'web-01', serial_number: 'SN1', ru_size: 2, model_make: 'Dell', model_name: 'R740' },
  ...over,
});

describe('renderRackSvg', () => {
  it('renders a FRONT elevation with the block label, RU numbers and inline styles', () => {
    const out = renderRackSvg({ rackName: 'R1', side: 'source', rows: [row({})] });
    expect(out).toContain('<svg');
    expect(out).toContain('web-01');
    expect(out).toContain('>54<');
    expect(out).toContain('FRONT');
    expect(out).not.toContain('REAR');
    expect(out).toContain('<style>');
    expect(out).toContain('.rack-faceplate-verified');
  });
  it('adds a REAR elevation only when a rear-positioned asset exists', () => {
    const out = renderRackSvg({ rackName: 'R1', side: 'source', rows: [
      row({}), row({ id: 'r2', source_ru: 20, source_position: 'rear',
                     asset: { name: 'pdu-1', serial_number: null, ru_size: 1, model_make: null, model_name: null } }),
    ] });
    expect(out).toContain('REAR');
    expect(out).toContain('pdu-1');
  });
  it('ignores rows on other racks or the other side', () => {
    const out = renderRackSvg({ rackName: 'R1', side: 'destination', rows: [row({})] });
    expect(out).toContain('No assets recorded at this rack');
  });
});
