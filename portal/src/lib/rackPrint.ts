/**
 * Print-sheet HTML for the rack view: heading, the live-DOM-serialized
 * elevation SVGs (fills/strokes/label colors are inline attributes — see
 * RackViewModal — so only structural line-work needs the small stylesheet
 * here), the device manifest, and the legend. Sized to the INTERSECTION
 * of Letter and A4 printable areas (7.2in × 10in content box, 0.5in
 * margins) so one sheet prints on either paper without clipping.
 * Escaped with a plain text-escaper — every dynamic string passes through
 * esc() — since this document is written into a user-opened window.
 */
import type { DeviceListRow, LegendCategory } from './initiatives';
import { UNCATEGORIZED_FILL } from './initiatives';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const SHEET_CSS = `
  @page { margin: 0.5in; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-monospace, Menlo, Consolas, monospace;
         color: #111827; background: #fff; width: 7.2in; }
  h1 { font-size: 14pt; margin: 0 0 0.15in; font-weight: 600; }
  .sheet { display: flex; gap: 0.25in; align-items: stretch; }
  .elevations { display: flex; gap: 0.2in; height: 9.2in; flex: none; }
  .elevations svg { height: 100%; width: auto; }
  .list { flex: 1; font-size: 8pt; min-width: 0;
          display: flex; flex-direction: column; justify-content: flex-end; }
  .group { font-size: 7pt; letter-spacing: 0.08em; color: #6b7280;
           margin: 0.08in 0 0.03in; font-weight: 600; }
  .row { display: grid; grid-template-columns: 10px 1fr auto auto; gap: 6px;
         align-items: center; padding: 2px 0; border-bottom: 1px solid #d7dce2; }
  .swatch { width: 8px; height: 8px; border-radius: 2px;
            border: 1px solid rgba(17,24,39,0.35); }
  .model { color: #374151; }
  .ru { text-align: right; min-width: 0.4in; }
  .legend { display: flex; gap: 0.2in; margin-top: 0.12in; font-size: 8pt;
            align-items: center; flex-wrap: wrap; }
  .legend .swatch { display: inline-block; vertical-align: -1px; margin-right: 4px; }
  .key-verified { background: #fff; border: 2px solid #15803d; }
  .key-planned { background: #fff; border: 1.5px dashed #111827; }
  /* structural rack line-work (classes come through with the serialized SVG) */
  .rack-post { fill: #f4f6f8; stroke: #111827; stroke-width: 1.5; }
  .rack-cap { fill: #e5e8ec; stroke: #111827; stroke-width: 1.5; }
  .rack-interior { fill: #fff; stroke: #111827; stroke-width: 1; }
  .rack-u-hairline { stroke: #e5e7eb; stroke-width: 0.5; }
  .rack-u-label { font-size: 7px; fill: #6b7280;
                  font-family: ui-monospace, Menlo, monospace; }
  .rack-block-label { font-size: 8.5px;
                      font-family: ui-monospace, Menlo, monospace; }
  .rack-faceplate-ghost { fill: #fff; stroke: #c9ced6; stroke-width: 1; }
  .rack-empty-label { font-size: 10px; fill: #6b7280; }
`;

export function buildRackPrintHtml(input: {
  rackName: string; sideLabel: string; svgs: string[];
  listRows: DeviceListRow[]; grouped: boolean; legend: LegendCategory[];
}): string {
  let lastGroup: string | null = null;
  const listHtml = input.listRows.map((r) => {
    const head = input.grouped && r.group !== lastGroup
      ? `<div class="group">${r.group}</div>` : '';
    lastGroup = r.group;
    return `${head}<div class="row">`
      + `<span class="swatch" style="background:${esc(r.categoryColor ?? UNCATEGORIZED_FILL)}"></span>`
      + `<span>${esc(r.name)}</span>`
      + `<span class="model">${esc(r.makeModel)}</span>`
      + `<span class="ru">${esc(r.ruText)}</span></div>`;
  }).join('');
  const legendHtml = [
    ...input.legend.map((c) =>
      `<span><span class="swatch" style="background:${esc(c.color)}"></span>${esc(c.label)}</span>`),
    '<span><span class="swatch key-verified"></span>Verified</span>',
    '<span><span class="swatch key-planned"></span>Planned</span>',
  ].join('');
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<title>Rack ${esc(input.rackName)} — ${esc(input.sideLabel)}</title>`
    + `<style>${SHEET_CSS}</style></head><body>`
    + `<h1>Rack ${esc(input.rackName)} — ${esc(input.sideLabel)}</h1>`
    + `<div class="sheet"><div class="elevations">${input.svgs.join('')}</div>`
    + `<div class="list">${listHtml}</div></div>`
    + `<div class="legend">${legendHtml}</div>`
    + `<script>window.onload = () => window.print();</script>`
    + `</body></html>`;
}
