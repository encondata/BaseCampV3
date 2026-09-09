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
import { rackLayout } from '../lib/initiatives';
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
      'name' | 'serial_number' | 'ru_size' | 'model_make' | 'model_name'>;
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
  const sideLabel = input.side === 'source' ? 'Source' : 'Destination';
  const markup = renderToStaticMarkup(
    <div className="rack-elevations">
      <RackElevation heading="FRONT" blocks={frontDisplay}
                     ariaLabel={`Rack ${input.rackName} — ${sideLabel} — front elevation`} />
      {rear.length > 0 && (
        <RackElevation heading="REAR" blocks={rearDisplay}
                       ariaLabel={`Rack ${input.rackName} — ${sideLabel} — rear elevation`} />
      )}
    </div>,
  );
  return `<style>${rackCss}</style>${markup}`;
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
