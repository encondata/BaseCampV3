/**
 * Server-side rack elevation renderer for the report-worker. Reuses the
 * portal's RackElevation + rackLayout verbatim so PDFs draw the exact rack
 * the modal draws. Built by `npm run build:rack-renderer` into
 * dist-node/render-rack.js; the Python side pipes
 * {rackName, side, rows} as JSON on stdin and reads markup on stdout.
 */
import { renderToStaticMarkup } from 'react-dom/server';

import { RackElevation, ghostBlocksFor, isRearPosition } from '../components/initiatives/RackElevation';
import type { DisplayBlock } from '../components/initiatives/RackElevation';
import { rackLayout, nodeBlocks } from '../lib/initiatives';
import type { InitiativeAssetRow, InitiativeAssetSummary } from '../lib/api';
import rackCss from '../styles/rack-svg.css?raw';

// Minimal Node ambient types — the portal has no @types/node, and this is
// the only file that runs under Node.
declare const process: {
  argv: string[];
  stdin: AsyncIterable<string> & { setEncoding(encoding: string): void };
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  exit(code: number): never;
};

/**
 * Exactly the `InitiativeAssetRow` fields `rackLayout` reads — which is all
 * the Python side sends (MoveAsset.to_row() in reports/move_report/gather.py
 * builds this subset, not a whole API row). Derived from the portal's own
 * types with `Pick` so a rename on either end is a compile error here rather
 * than a silently blank elevation.
 */
export type RackRow =
  Pick<InitiativeAssetRow,
    'id' | 'source_rack' | 'source_ru' | 'source_verified' | 'source_position'
    | 'destination_rack' | 'destination_ru' | 'destination_verified'
    | 'destination_position'>
  & {
    asset: Pick<InitiativeAssetSummary,
      'name' | 'serial_number' | 'ru_size' | 'model_form_factor'
      | 'model_make' | 'model_name'
      | 'model_category_label' | 'model_category_color'>;
  };

export interface RenderRackInput {
  rackName: string;
  side: 'source' | 'destination';
  rows: RackRow[];
}

export function renderRackSvg(input: RenderRackInput): string {
  // Safe widening: `rackLayout` is typed against the full API row but only
  // touches the fields `RackRow` guarantees (see its Pick above).
  const blocks = rackLayout(input.rows as InitiativeAssetRow[], input.rackName, input.side);
  const front = blocks.filter((b) => !isRearPosition(b.position));
  const rear = blocks.filter((b) => isRearPosition(b.position));
  const frontDisplay: DisplayBlock[] = [...front, ...ghostBlocksFor(rear)];
  const rearDisplay: DisplayBlock[] = [...rear, ...ghostBlocksFor(front)];
  // Mirrors the modal: a side whose devices house nodes gets a second
  // frame of node cells right after its devices frame, with that side's
  // child-less devices as ghosts for RU context (see `nodeBlocks`).
  const frontNodes = nodeBlocks(front);
  const rearNodes = nodeBlocks(rear);
  const nodeDisplay = (sideBlocks: typeof blocks, cells: typeof blocks): DisplayBlock[] =>
    [...cells, ...ghostBlocksFor(sideBlocks.filter((b) => b.children.length === 0))];
  const sideLabel = input.side === 'source' ? 'Source' : 'Destination';
  const markup = renderToStaticMarkup(
    <div className="rack-elevations">
      <RackElevation heading="FRONT" blocks={frontDisplay}
                     ariaLabel={`Rack ${input.rackName} — ${sideLabel} — front elevation`} />
      {frontNodes.length > 0 && (
        <RackElevation heading="FRONT · NODES" blocks={nodeDisplay(front, frontNodes)}
                       ariaLabel={`Rack ${input.rackName} — ${sideLabel} — front nodes elevation`} />
      )}
      {rear.length > 0 && (
        <RackElevation heading="REAR" blocks={rearDisplay}
                       ariaLabel={`Rack ${input.rackName} — ${sideLabel} — rear elevation`} />
      )}
      {rear.length > 0 && rearNodes.length > 0 && (
        <RackElevation heading="REAR · NODES" blocks={nodeDisplay(rear, rearNodes)}
                       ariaLabel={`Rack ${input.rackName} — ${sideLabel} — rear nodes elevation`} />
      )}
    </div>,
  );
  // WeasyPrint does not cascade document-level CSS into an inline <svg>, so a
  // single outer <style> leaves every shape at the SVG default `fill: black`.
  // Keep the outer copy (the HTML container rules .rack-elevations /
  // .rack-elevation / .rack-elevation-heading need it) and inject a second copy
  // as the first child of each <svg>. CSS comments are stripped because
  // rack-svg.css contains the literal text `<svg>` in a comment, which the HTML
  // parser would treat as a tag once inside foreign content.
  const css = rackCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const styled = markup.replace(/<svg\b[^>]*>/g, (tag) => `${tag}<style>${css}</style>`);
  return `<style>${htmlOnlyCss(css)}</style>${styled}`;
}

/** SVG presentation properties are meaningless to WeasyPrint's HTML CSS
 *  parser (it logs "Ignored `fill: …`, unknown property" for each one), so
 *  the OUTER copy of the stylesheet keeps only what the HTML containers
 *  need. The copies injected inside each <svg> stay complete. */
const SVG_ONLY_PROPS = /(?:^|;)\s*(?:fill|stroke|stroke-width|stroke-dasharray|stroke-linecap|stroke-linejoin|shape-rendering|dominant-baseline|text-anchor|paint-order|vector-effect|fill-opacity|stroke-opacity)\s*:[^;}]*/g;

export function htmlOnlyCss(css: string): string {
  return css.replace(/\{([^}]*)\}/g, (_m, body: string) => {
    const kept = body.replace(SVG_ONLY_PROPS, (m) => (m.startsWith(';') ? ';' : ''));
    return `{${kept.replace(/;\s*;/g, ';').replace(/^\s*;/, '')}}`;
  });
}

async function main(): Promise<void> {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw) as RenderRackInput;
  process.stdout.write(renderRackSvg(input));
}

// Only run as a CLI when executed directly (node dist-node/render-rack.js),
// not when imported by tests.
if (typeof process !== 'undefined' && process.argv[1]
    && /render-rack\.js$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    process.stderr.write(`render-rack: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
