/**
 * Right rail of the label builder: geometry (x/y/w/h/rotation, common to
 * every element type) + per-type fields + an "Insert variable" picker
 * that appends `{key}` tokens into text content / barcode / qr data. All
 * numeric edits are guarded with `Number.isFinite` before patching so a
 * mid-edit empty/invalid input never dispatches `NaN` into the reducer.
 */

import { useState } from 'react';
import type { ChangeEvent } from 'react';

import type { LabelPlaceholder } from '../../lib/api';
import { placeholdersFor } from '../../lib/labels';
import type { LabelEl, Rotation } from '../../lib/labelModel';

interface Props {
  element: LabelEl | null;
  placeholders: LabelPlaceholder[];
  labelType: string;
  onPatch: (id: string, patch: Partial<LabelEl>) => void;
  onRemove: (id: string) => void;
}

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

export default function PropertiesPanel({
  element, placeholders, labelType, onPatch, onRemove,
}: Props) {
  const [insertKey, setInsertKey] = useState('');

  if (!element) {
    return (
      <div className="lbl-props">
        <div className="lbl-props-hint">Select an element to edit its properties.</div>
      </div>
    );
  }

  const id = element.id;

  const patchGeometry = (field: 'x' | 'y' | 'w' | 'h') =>
    (e: ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      onPatch(id, { [field]: v });
    };

  const handleRotation = (e: ChangeEvent<HTMLSelectElement>) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    onPatch(id, { rotation: v as Rotation });
  };

  const showInsert = element.type === 'text' || element.type === 'barcode' || element.type === 'qr';
  const options = showInsert ? placeholdersFor(placeholders, labelType) : [];

  const handleInsert = (e: ChangeEvent<HTMLSelectElement>) => {
    const key = e.target.value;
    setInsertKey('');
    if (!key) return;
    if (element.type === 'text') {
      onPatch(id, { content: element.content + `{${key}}` });
    } else if (element.type === 'barcode' || element.type === 'qr') {
      onPatch(id, { data: element.data + `{${key}}` });
    }
  };

  return (
    <div className="lbl-props">
      <div className="pf-form">
        <div>
          <label htmlFor="prop-x">X (in)</label>
          <input id="prop-x" type="number" step={0.025} min={0}
                 value={element.x} onChange={patchGeometry('x')} />
        </div>
        <div>
          <label htmlFor="prop-y">Y (in)</label>
          <input id="prop-y" type="number" step={0.025} min={0}
                 value={element.y} onChange={patchGeometry('y')} />
        </div>
        <div>
          <label htmlFor="prop-w">W (in)</label>
          <input id="prop-w" type="number" step={0.025} min={0}
                 value={element.w} onChange={patchGeometry('w')} />
        </div>
        <div>
          <label htmlFor="prop-h">H (in)</label>
          <input id="prop-h" type="number" step={0.025} min={0}
                 value={element.h} onChange={patchGeometry('h')} />
        </div>
        <div className="full">
          <label htmlFor="prop-rotation">Rotation</label>
          <select id="prop-rotation" value={element.rotation} onChange={handleRotation}>
            {ROTATIONS.map((r) => <option key={r} value={r}>{r}°</option>)}
          </select>
        </div>
      </div>

      {element.type === 'text' && (
        <div className="pf-form">
          <div className="full">
            <label htmlFor="prop-content">Content</label>
            <textarea id="prop-content" rows={2} value={element.content}
                      onChange={(e) => onPatch(id, { content: e.target.value })} />
          </div>
          <div>
            <label htmlFor="prop-fontsize">Font size (pt)</label>
            <input id="prop-fontsize" type="number" value={element.fontSizePt}
                   onChange={(e) => {
                     const v = Number(e.target.value);
                     if (Number.isFinite(v)) onPatch(id, { fontSizePt: v });
                   }} />
          </div>
          <div>
            <label htmlFor="prop-align">Align</label>
            <select id="prop-align" value={element.align}
                    onChange={(e) => onPatch(id, {
                      align: e.target.value as 'left' | 'center' | 'right',
                    })}>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </div>
          <div className="full">
            <label htmlFor="prop-bold">Bold</label>
            <input id="prop-bold" type="checkbox" checked={element.bold}
                   onChange={(e) => onPatch(id, { bold: e.target.checked })} />
          </div>
        </div>
      )}

      {element.type === 'barcode' && (
        <div className="pf-form">
          <div className="full">
            <label htmlFor="prop-data">Data</label>
            <input id="prop-data" value={element.data}
                   onChange={(e) => onPatch(id, { data: e.target.value })} />
          </div>
          <div>
            <label htmlFor="prop-symbology">Symbology</label>
            <select id="prop-symbology" value={element.symbology}
                    onChange={(e) => onPatch(id, {
                      symbology: e.target.value as 'code128' | 'code39',
                    })}>
              <option value="code128">code128</option>
              <option value="code39">code39</option>
            </select>
          </div>
          <div>
            <label htmlFor="prop-showtext">Show text</label>
            <input id="prop-showtext" type="checkbox" checked={element.showText}
                   onChange={(e) => onPatch(id, { showText: e.target.checked })} />
          </div>
        </div>
      )}

      {element.type === 'qr' && (
        <div className="pf-form">
          <div className="full">
            <label htmlFor="prop-data">Data</label>
            <input id="prop-data" value={element.data}
                   onChange={(e) => onPatch(id, { data: e.target.value })} />
          </div>
        </div>
      )}

      {(element.type === 'line' || element.type === 'box') && (
        <div className="pf-form">
          <div>
            <label htmlFor="prop-stroke">Stroke (in)</label>
            <input id="prop-stroke" type="number" step={0.005} min={0}
                   value={element.strokeIn}
                   onChange={(e) => {
                     const v = Number(e.target.value);
                     if (Number.isFinite(v)) onPatch(id, { strokeIn: v });
                   }} />
          </div>
        </div>
      )}

      {showInsert && (
        <div className="pf-form">
          <div className="full">
            <label htmlFor="prop-insert">Insert variable</label>
            <select id="prop-insert" value={insertKey} onChange={handleInsert}>
              <option value="">Insert variable…</option>
              {options.map((p) => (
                <option key={p.key} value={p.key}>{p.label} — {p.sample_value}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      <button type="button" className="mini-btn danger" onClick={() => onRemove(id)}>
        Delete element
      </button>
    </div>
  );
}
