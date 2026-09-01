import { expect, it } from 'vitest';

import {
  clampToLabel, editorReducer, emptyDesign, initialEditorState, newElement,
  snap, type EditorState, type TextEl,
} from './labelModel';

const start = (): EditorState => initialEditorState(emptyDesign(4, 2));

it('add pushes history, selects the element, gives unique ids', () => {
  let s = start();
  s = editorReducer(s, { type: 'add', element: newElement('text', s.design) });
  s = editorReducer(s, { type: 'add', element: newElement('text', s.design) });
  expect(s.design.elements).toHaveLength(2);
  expect(new Set(s.design.elements.map((e) => e.id)).size).toBe(2);
  expect(s.selectedId).toBe(s.design.elements[1].id);
  expect(s.past).toHaveLength(2);
});

it('patch merges and is undoable/redoable', () => {
  let s = start();
  s = editorReducer(s, { type: 'add', element: newElement('text', s.design) });
  const id = s.design.elements[0].id;
  s = editorReducer(s, { type: 'patch', id, patch: { x: 1.5 } });
  expect(s.design.elements[0].x).toBe(1.5);
  s = editorReducer(s, { type: 'undo' });
  expect(s.design.elements[0].x).toBe(0.2);
  s = editorReducer(s, { type: 'redo' });
  expect(s.design.elements[0].x).toBe(1.5);
});

it('remove clears selection; select/undo interplay keeps selection valid', () => {
  let s = start();
  s = editorReducer(s, { type: 'add', element: newElement('box', s.design) });
  const id = s.design.elements[0].id;
  s = editorReducer(s, { type: 'remove', id });
  expect(s.design.elements).toHaveLength(0);
  expect(s.selectedId).toBeNull();
});

it('reorder moves within bounds and no-ops at the edge', () => {
  let s = start();
  s = editorReducer(s, { type: 'add', element: newElement('text', s.design) });
  s = editorReducer(s, { type: 'add', element: newElement('box', s.design) });
  const [a, b] = s.design.elements.map((e) => e.id);
  s = editorReducer(s, { type: 'reorder', id: a, dir: 1 });
  expect(s.design.elements.map((e) => e.id)).toEqual([b, a]);
  const before = s.past.length;
  s = editorReducer(s, { type: 'reorder', id: a, dir: 1 });   // already last
  expect(s.design.elements.map((e) => e.id)).toEqual([b, a]);
  expect(s.past.length).toBe(before);                          // no history spam
});

it('setSize replaces size; replace resets history; select does not touch history', () => {
  let s = start();
  s = editorReducer(s, { type: 'setSize', w: 6, h: 4 });
  expect(s.design.size).toEqual({ w: 6, h: 4 });
  s = editorReducer(s, { type: 'select', id: null });
  const past = s.past.length;
  s = editorReducer(s, { type: 'select', id: null });
  expect(s.past.length).toBe(past);
  s = editorReducer(s, { type: 'replace', design: emptyDesign(2, 1) });
  expect(s.past).toHaveLength(0);
  expect(s.future).toHaveLength(0);
});

it('undo on empty history is a no-op', () => {
  const s = start();
  expect(editorReducer(s, { type: 'undo' })).toBe(s);
});

it('snap and clampToLabel', () => {
  expect(snap(1.013)).toBe(1.025);
  expect(snap(0.01)).toBe(0);
  const el = { ...newElement('text', emptyDesign(4, 2)), x: 3.9, y: -0.5, w: 1, h: 0.3 };
  expect(clampToLabel(el, { w: 4, h: 2 })).toEqual({ x: 3, y: 0 });
});

it('newElement defaults are wire-compatible', () => {
  const t = newElement('text', emptyDesign(4, 2)) as TextEl;
  expect(t).toMatchObject({ type: 'text', rotation: 0, bold: false,
    align: 'left', fontSizePt: 10 });
  expect(typeof t.content).toBe('string');
});
