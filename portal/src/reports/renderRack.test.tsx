// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { renderRackSvg } from './renderRack';

const row = (over: Record<string, unknown>) => ({
  id: 'r1', source_rack: 'R1', source_ru: 10, source_verified: true, source_position: null,
  destination_rack: null, destination_ru: null, destination_verified: null,
  destination_position: null,
  asset: { name: 'web-01', serial_number: 'SN1', ru_size: 2, model_make: 'Dell', model_name: 'R740',
           model_category_label: null, model_category_color: null },
  ...over,
});

describe('renderRackSvg', () => {
  it('renders a FRONT elevation with the block label, RU numbers and inline styles', () => {
    const out = renderRackSvg({ rackName: 'R1', side: 'source', rows: [row({})] });
    expect(out).toContain('<svg');
    expect(out).toContain('web-01');
    expect(out).toContain('>52<');
    expect(out).not.toContain('>53<');
    expect(out).toContain('FRONT');
    expect(out).not.toContain('REAR');
    expect(out).toContain('<style>');
    expect(out).toContain('.rack-post');
  });
  it('fills faceplates inline with the model category color and a contrast label', () => {
    const out = renderRackSvg({ rackName: 'R1', side: 'source', rows: [
      row({ asset: { name: 'web-01', serial_number: 'SN1', ru_size: 2, model_make: 'Dell',
                     model_name: 'R740', model_category_label: 'Server',
                     model_category_color: '#1668a7' } }),
      row({ id: 'r2', source_ru: 20, source_verified: false }),
    ] });
    // verified + categorized: category fill, white label, solid green border
    expect(out).toMatch(/<rect[^>]*fill="#1668a7"[^>]*stroke="#15803d"[^>]*class="rack-faceplate"/);
    expect(out).toMatch(/<text[^>]*fill="#ffffff"[^>]*class="rack-block-label"[^>]*>web-01</);
    // planned + uncategorized: neutral fill, dashed dark border, no vents/LED
    expect(out).toMatch(/<rect[^>]*fill="#eef0f3"[^>]*stroke-dasharray="4 3"/);
    expect(out).not.toContain('rack-faceplate-vent');
    expect(out).not.toContain('rack-led-');
  });
  it('adds a REAR elevation only when a rear-positioned asset exists', () => {
    const out = renderRackSvg({ rackName: 'R1', side: 'source', rows: [
      row({}), row({ id: 'r2', source_ru: 20, source_position: 'rear',
                     asset: { name: 'pdu-1', serial_number: null, ru_size: 1, model_make: null, model_name: null,
                              model_category_label: null, model_category_color: null } }),
    ] });
    expect(out).toContain('REAR');
    expect(out).toContain('pdu-1');
  });
  it('inlines the CSS inside each <svg> so WeasyPrint applies it', () => {
    // WeasyPrint does not cascade document CSS into inline SVG: without a
    // <style> *inside* the <svg> every shape prints as solid black.
    const out = renderRackSvg({ rackName: 'R1', side: 'source', rows: [row({})] });
    expect(out).toMatch(/<svg[^>]*><style>[^<]*\.rack-post/);
    // rack-svg.css has a comment containing the literal text `<svg>`; left in,
    // the HTML parser would treat it as a tag inside foreign content.
    for (const block of out.match(/<style>[\s\S]*?<\/style>/g) ?? []) {
      expect(block).not.toContain('<svg>');
    }
  });
  it('ignores rows on other racks or the other side', () => {
    const out = renderRackSvg({ rackName: 'R1', side: 'destination', rows: [row({})] });
    expect(out).toContain('No assets recorded at this rack');
  });
});

it('keeps SVG-only properties out of the outer <style> but inside every <svg> copy', async () => {
  const { htmlOnlyCss } = await import('./renderRack');
  const out = htmlOnlyCss('.a { fill: #fff; stroke: #000; stroke-width: 1; width: 100%; } .b { display: block; shape-rendering: crispEdges; }');
  expect(out).not.toMatch(/fill|stroke|shape-rendering/);
  expect(out).toMatch(/width: 100%/);
  expect(out).toMatch(/display: block/);
});
