/**
 * The label element model + editor reducer. Pure TS — no React, no
 * fetching. Coordinates are ALWAYS inches; the canvas and the API
 * compilers share this exact JSON shape (camelCase props on the wire).
 * History is snapshot-based over `design` only (selection is not
 * undoable), capped at HISTORY_LIMIT.
 */

export type Rotation = 0 | 90 | 180 | 270;

interface BaseEl { id: string; x: number; y: number; w: number; h: number; rotation: Rotation }
export interface TextEl extends BaseEl { type: 'text'; content: string; fontSizePt: number; bold: boolean; align: 'left' | 'center' | 'right' }
export interface BarcodeEl extends BaseEl { type: 'barcode'; symbology: 'code128' | 'code39'; data: string; showText: boolean }
export interface QrEl extends BaseEl { type: 'qr'; data: string }
export interface LineEl extends BaseEl { type: 'line'; strokeIn: number }
export interface BoxEl extends BaseEl { type: 'box'; strokeIn: number }
export type LabelEl = TextEl | BarcodeEl | QrEl | LineEl | BoxEl;

export interface LabelDesign { size: { w: number; h: number }; elements: LabelEl[] }

export interface EditorState {
  design: LabelDesign;
  selectedId: string | null;
  past: LabelDesign[];
  future: LabelDesign[];
}

export type EditorAction =
  | { type: 'add'; element: LabelEl }
  | { type: 'patch'; id: string; patch: Partial<LabelEl> }
  | { type: 'remove'; id: string }
  | { type: 'reorder'; id: string; dir: 1 | -1 }
  | { type: 'select'; id: string | null }
  | { type: 'setSize'; w: number; h: number }
  | { type: 'replace'; design: LabelDesign }
  | { type: 'undo' }
  | { type: 'redo' };

export const HISTORY_LIMIT = 100;
const GRID = 0.025;

export function snap(v: number): number {
  return Math.round(Math.round(v / GRID) * GRID * 1000) / 1000;
}

export function emptyDesign(w: number, h: number): LabelDesign {
  return { size: { w, h }, elements: [] };
}

export function initialEditorState(design: LabelDesign): EditorState {
  return { design, selectedId: null, past: [], future: [] };
}

const PREFIX: Record<LabelEl['type'], string> = {
  text: 't', barcode: 'b', qr: 'q', line: 'l', box: 'x',
};

export function newElement(type: LabelEl['type'], design: LabelDesign): LabelEl {
  const used = new Set(design.elements.map((e) => e.id));
  let n = 1;
  while (used.has(`${PREFIX[type]}${n}`)) n += 1;
  const base = { id: `${PREFIX[type]}${n}`, x: 0.2, y: 0.2, rotation: 0 as Rotation };
  switch (type) {
    case 'text':
      return { ...base, type, w: 1.5, h: 0.25, content: 'Text',
               fontSizePt: 10, bold: false, align: 'left' };
    case 'barcode':
      return { ...base, type, w: 2, h: 0.5, symbology: 'code128',
               data: '{asset_id}', showText: true };
    case 'qr':
      return { ...base, type, w: 0.6, h: 0.6, data: '{asset_id}' };
    case 'line':
      return { ...base, type, w: 1.5, h: 0, strokeIn: 0.01 };
    case 'box':
      return { ...base, type, w: 1.5, h: 1, strokeIn: 0.02 };
  }
}

export function clampToLabel(
  el: LabelEl, size: { w: number; h: number },
): Partial<LabelEl> {
  return {
    x: Math.min(Math.max(el.x, 0), Math.max(0, size.w - el.w)),
    y: Math.min(Math.max(el.y, 0), Math.max(0, size.h - el.h)),
  };
}

function commit(state: EditorState, design: LabelDesign,
                selectedId: string | null = state.selectedId): EditorState {
  return {
    design,
    selectedId,
    past: [...state.past, state.design].slice(-HISTORY_LIMIT),
    future: [],
  };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'add':
      return commit(state,
        { ...state.design, elements: [...state.design.elements, action.element] },
        action.element.id);
    case 'patch': {
      const elements = state.design.elements.map((e) =>
        e.id === action.id ? ({ ...e, ...action.patch } as LabelEl) : e);
      return commit(state, { ...state.design, elements });
    }
    case 'remove': {
      const elements = state.design.elements.filter((e) => e.id !== action.id);
      if (elements.length === state.design.elements.length) return state;
      return commit(state, { ...state.design, elements },
        state.selectedId === action.id ? null : state.selectedId);
    }
    case 'reorder': {
      const i = state.design.elements.findIndex((e) => e.id === action.id);
      const j = i + action.dir;
      if (i < 0 || j < 0 || j >= state.design.elements.length) return state;
      const elements = [...state.design.elements];
      [elements[i], elements[j]] = [elements[j], elements[i]];
      return commit(state, { ...state.design, elements });
    }
    case 'select':
      if (action.id === state.selectedId) return state;
      return { ...state, selectedId: action.id };
    case 'setSize':
      return commit(state, { ...state.design, size: { w: action.w, h: action.h } });
    case 'replace':
      return initialEditorState(action.design);
    case 'undo': {
      const prev = state.past[state.past.length - 1];
      if (!prev) return state;
      return { design: prev, selectedId: state.selectedId,
               past: state.past.slice(0, -1),
               future: [state.design, ...state.future] };
    }
    case 'redo': {
      const next = state.future[0];
      if (!next) return state;
      return { design: next, selectedId: state.selectedId,
               past: [...state.past, state.design],
               future: state.future.slice(1) };
    }
  }
}
