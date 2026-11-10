/** One step on the flow canvas: its title, an input port on the left (none
 *  on Scan input) and one labeled output port per output on the right.
 *  The look (warned, on the lit test path, dimmed off it) comes from the
 *  canvas as booleans. The ports are React Flow's <Handle>, handed in by
 *  FlowCanvas (the only file that imports the library); each sits inside
 *  its row, which is positioned, so a port lines up with its label. */

import type { ReactNode } from 'react';

import { nodeTitle, outputsFor, type FlowNode } from '../../lib/matchingRules';

export interface FlowNodeLook {
  warn: boolean;
  lit: boolean;
  dim: boolean;
}

/** Renders one port: the input (`target`, id `in`) or an output (`source`). */
export type HandleSlot = (kind: 'target' | 'source', id: string) => ReactNode;

export default function FlowNodeView({ node, look, handle }: {
  node: FlowNode;
  look: FlowNodeLook;
  handle: HandleSlot;
}) {
  const outputs = outputsFor(node);
  const cls = [
    'mr-node', `mr-node-${node.kind}`,
    look.warn ? 'mr-warn' : '',
    look.lit ? 'mr-lit' : '',
    look.dim ? 'mr-dim' : '',
  ].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <div className="mr-node-title">
        {node.kind !== 'scan_input' && handle('target', 'in')}
        <span>{nodeTitle(node)}</span>
      </div>
      {outputs.length > 0 && (
        <div className="mr-node-outs">
          {outputs.map((out) => (
            <div key={out} className="mr-node-out">
              <span className="mr-node-out-label">{out}</span>
              {handle('source', out)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
