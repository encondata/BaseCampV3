/**
 * Left rail of the label builder: "add element" buttons over a Layers
 * list. The list is reversed (top layer — last in the elements array,
 * drawn last / on top — shown first) with per-row reorder/delete.
 */

import type { LabelEl } from '../../lib/labelModel';

interface Props {
  onAdd: (type: LabelEl['type']) => void;
  layers: LabelEl[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onReorder: (id: string, dir: 1 | -1) => void;
  onRemove: (id: string) => void;
}

const ADD_TYPES: { type: LabelEl['type']; label: string }[] = [
  { type: 'text', label: '+ Text' },
  { type: 'barcode', label: '+ Barcode' },
  { type: 'qr', label: '+ QR' },
  { type: 'line', label: '+ Line' },
  { type: 'box', label: '+ Box' },
];

export default function ElementPalette({
  onAdd, layers, selectedId, onSelect, onReorder, onRemove,
}: Props) {
  const reversed = [...layers].reverse();

  return (
    <div className="lbl-palette">
      {ADD_TYPES.map(({ type, label }) => (
        <button key={type} type="button" className="mini-btn" onClick={() => onAdd(type)}>
          {label}
        </button>
      ))}

      <div className="eyebrow-sm">Layers</div>
      <div className="lbl-layers">
        {reversed.map((el) => (
          <div
            key={el.id}
            className={`lbl-layer${el.id === selectedId ? ' on' : ''}`}
            onClick={() => onSelect(el.id)}
          >
            <span className="lbl-layer-label">{el.type} · {el.id}</span>
            <button type="button" className="mini-btn" aria-label={`Move ${el.id} up`}
                    onClick={(e) => { e.stopPropagation(); onReorder(el.id, 1); }}>
              ↑
            </button>
            <button type="button" className="mini-btn" aria-label={`Move ${el.id} down`}
                    onClick={(e) => { e.stopPropagation(); onReorder(el.id, -1); }}>
              ↓
            </button>
            <button type="button" className="mini-btn" aria-label={`Remove ${el.id}`}
                    onClick={(e) => { e.stopPropagation(); onRemove(el.id); }}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
