import { describe, expect, it } from 'vitest';

import { buildRackPrintHtml } from './rackPrint';

const row = { id: 'a', name: 'top-dev', makeModel: 'Dell R740', ruText: '40–41',
  categoryColor: '#1668a7', group: 'FRONT' as const };

describe('buildRackPrintHtml', () => {
  it('embeds heading, svgs, list rows, legend, page sizing, and auto-print', () => {
    const html = buildRackPrintHtml({
      rackName: 'R12', sideLabel: 'Destination',
      svgs: ['<svg data-x="1"></svg>', '<svg data-x="2"></svg>'],
      listRows: [row], grouped: false,
      legend: [{ label: 'Server', color: '#1668a7' }],
    });
    expect(html).toContain('Rack R12 — Destination');
    expect(html).toContain('data-x="1"');
    expect(html).toContain('data-x="2"');
    expect(html).toContain('top-dev');
    expect(html).toContain('Dell R740');
    expect(html).toContain('40–41');
    expect(html).toContain('Server');
    expect(html).toContain('@page { margin: 0.5in; }');
    expect(html).toContain('window.print()');
  });
  it('escapes HTML in names', () => {
    const html = buildRackPrintHtml({
      rackName: '<img>', sideLabel: 'Source', svgs: [], grouped: false,
      listRows: [{ ...row, name: 'a<b>&c' }], legend: [],
    });
    expect(html).not.toContain('<img>');
    expect(html).toContain('&lt;img&gt;');
    expect(html).toContain('a&lt;b&gt;&amp;c');
  });
  it('renders FRONT/REAR subheads when grouped', () => {
    const html = buildRackPrintHtml({
      rackName: 'R1', sideLabel: 'Source', svgs: [],
      listRows: [row, { ...row, id: 'r', group: 'REAR' as const }],
      grouped: true, legend: [],
    });
    expect(html).toContain('>FRONT<');
    expect(html).toContain('>REAR<');
  });
});
