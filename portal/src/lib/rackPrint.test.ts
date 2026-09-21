import { describe, expect, it } from 'vitest';

import { buildRackPrintHtml } from './rackPrint';

const row = { id: 'a', name: 'top-dev', makeModel: 'Dell R740', ruText: '40..41',
  categoryColor: '#1668a7', group: 'FRONT' as const, indent: false, orphan: false };

describe('buildRackPrintHtml', () => {
  it('embeds heading, svgs, list rows, legend, page sizing, and auto-print', () => {
    const html = buildRackPrintHtml({
      rackName: 'R12', sideLabel: 'Destination',
      frames: [{ heading: 'FRONT', svg: '<svg data-x="1"></svg>' },
               { heading: 'REAR', svg: '<svg data-x="2"></svg>' }],
      listRows: [row], grouped: false,
      legend: [{ label: 'Server', color: '#1668a7' }],
    });
    expect(html).toContain('Rack R12 — Destination');
    expect(html).toContain('data-x="1"');
    expect(html).toContain('data-x="2"');
    expect(html).toContain('top-dev');
    expect(html).toContain('Dell R740');
    expect(html).toContain('40..41');
    expect(html).toContain('Server');
    expect(html).toContain('@page { margin: 0.5in; }');
    expect(html).toContain('window.print()');
    // one-page guard: content wrapped in #page and zoomed to the 9.3in
    // budget before the print dialog opens
    expect(html).toContain('<div id="page">');
    expect(html).toContain('9.3 * 96');
    expect(html).toContain('page.style.zoom');
  });
  it('escapes HTML in names', () => {
    const html = buildRackPrintHtml({
      rackName: '<img>', sideLabel: 'Source', frames: [], grouped: false,
      listRows: [{ ...row, name: 'a<b>&c' }], legend: [],
    });
    expect(html).not.toContain('<img>');
    expect(html).toContain('&lt;img&gt;');
    expect(html).toContain('a&lt;b&gt;&amp;c');
  });
  it('renders FRONT/REAR subheads when grouped', () => {
    const html = buildRackPrintHtml({
      rackName: 'R1', sideLabel: 'Source', frames: [],
      listRows: [row, { ...row, id: 'r', group: 'REAR' as const }],
      grouped: true, legend: [],
    });
    expect(html).toContain('>FRONT<');
    expect(html).toContain('>REAR<');
  });

  it('indents a child row and marks an orphan row with a "! " prefix', () => {
    const html = buildRackPrintHtml({
      rackName: 'R1', sideLabel: 'Source', frames: [],
      listRows: [
        { ...row, id: 'c', name: 'node-a1', indent: true },
        { ...row, id: 'o', name: 'san-01', orphan: true },
      ],
      grouped: false, legend: [],
    });
    expect(html).toContain('class="child"');
    expect(html).toContain('>! san-01');
  });

  it('captions every frame with its own heading once more than one is printed', () => {
    const two = buildRackPrintHtml({
      rackName: 'R1', sideLabel: 'Source',
      frames: [{ heading: 'FRONT', svg: '<svg data-x="f"></svg>' },
               { heading: 'REAR', svg: '<svg data-x="r"></svg>' }],
      listRows: [], grouped: true, legend: [],
    });
    expect(two).toContain('<div class="cap">FRONT</div><svg data-x="f">');
    expect(two).toContain('<div class="cap">REAR</div><svg data-x="r">');
    const three = buildRackPrintHtml({
      rackName: 'R1', sideLabel: 'Source',
      frames: [{ heading: 'FRONT', svg: '<svg data-x="f"></svg>' },
               { heading: 'FRONT · NODES', svg: '<svg data-x="fn"></svg>' },
               { heading: 'REAR', svg: '<svg data-x="r"></svg>' }],
      listRows: [], grouped: true, legend: [],
    });
    expect(three).toContain('<div class="cap">FRONT · NODES</div><svg data-x="fn">');
    expect(three.match(/class="cap"/g)).toHaveLength(3);
    // a lone frame needs no caption — nothing to disambiguate it from
    const one = buildRackPrintHtml({
      rackName: 'R1', sideLabel: 'Source',
      frames: [{ heading: 'FRONT', svg: '<svg data-x="f"></svg>' }],
      listRows: [], grouped: false, legend: [],
    });
    expect(one).not.toContain('class="cap"');
    expect(one).toContain('<svg data-x="f">');
  });
});
