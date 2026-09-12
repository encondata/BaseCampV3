/**
 * Server-side container label renderer for the report-worker. Builds the
 * exact same Avery 5164 PDF the portal's browser download produces, via the
 * shared `buildContainerLabelPdf` routine. Built by
 * `npm run build:container-labels` into
 * `dist-node/render-container-labels.js`, mirroring `renderRack.tsx` /
 * `render-rack.js`: the Python side pipes
 * `{ move, containers, tag_image_dir }` as JSON on stdin and reads a
 * base64-encoded PDF on stdout.
 */
import { buildContainerLabelPdf } from './containerLabelSheet';
import type { ContainerLabelContainer, ContainerLabelInput, ContainerLabelMove, TagKey } from './containerLabelSheet';
import { createNodeContainerLabelAdapters, readTagImages } from './containerLabelAdapters.node';

export interface RenderContainerLabelsInput {
  move: ContainerLabelMove;
  containers: ContainerLabelContainer[];
  /** Absolute path to the portal's `public/images` directory, so the Node
   *  side can read the tag PNGs from disk instead of fetching them. */
  tag_image_dir: string;
}

export async function renderContainerLabelsPdf(payload: RenderContainerLabelsInput): Promise<string> {
  const usedTags = new Set<TagKey>();
  for (const container of payload.containers) {
    if (container.tag) usedTags.add(container.tag);
  }

  const input: ContainerLabelInput = {
    move: payload.move,
    containers: payload.containers,
    tagImages: readTagImages(payload.tag_image_dir, usedTags),
  };

  const adapters = await createNodeContainerLabelAdapters(input);
  const doc = buildContainerLabelPdf(input, adapters) as unknown as { output(type: 'arraybuffer'): ArrayBuffer };
  const arrayBuffer = doc.output('arraybuffer');
  return Buffer.from(arrayBuffer).toString('base64');
}

async function main(): Promise<void> {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw) as RenderContainerLabelsInput;
  const base64 = await renderContainerLabelsPdf(payload);
  process.stdout.write(base64);
}

// Only run as a CLI when executed directly (node dist-node/render-container-labels.js),
// not when imported by tests.
if (typeof process !== 'undefined' && process.argv[1]
    && /render-container-labels\.js$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    process.stderr.write(`render-container-labels: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
