/** The editor's palette: one button per step kind. Drag one onto the canvas
 *  to place it there, or click it to add it at the canvas's center (the
 *  visible control for the drag). A flow has one Scan input, so that entry
 *  is disabled while the flow has it. */

import type { DragEvent } from 'react';

import { KINDS, type NodeKind } from '../../lib/matchingRules';

/** The drag-and-drop type a palette entry carries (its value is the kind). */
export const DRAG_TYPE = 'application/x-matching-node';

export default function NodePalette({ hasScanInput, onAdd }: {
  hasScanInput: boolean;
  onAdd: (kind: NodeKind) => void;
}) {
  const onDragStart = (e: DragEvent, kind: NodeKind) => {
    e.dataTransfer.setData(DRAG_TYPE, kind);
    e.dataTransfer.effectAllowed = 'move';
  };
  return (
    <section className="mr-side mr-palette-panel mr-scroll" aria-labelledby="mr-palette-title">
      <h2 className="mr-panel-title" id="mr-palette-title">Steps</h2>
      <p className="page-hint">Click to add, or drag onto the canvas.</p>
      <div className="mr-palette">
        {KINDS.map((k) => {
          const kind = k.key as NodeKind;
          const disabled = kind === 'scan_input' && hasScanInput;
          return (
            <button key={kind} type="button" className={`mini-btn mr-palette-item mr-node-${kind}`} disabled={disabled}
                    draggable={!disabled} onDragStart={(e) => onDragStart(e, kind)} onClick={() => onAdd(kind)}>
              {k.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
