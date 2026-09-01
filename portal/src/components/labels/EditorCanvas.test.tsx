// @vitest-environment jsdom
/**
 * EditorCanvas — SVG WYSIWYG canvas for the label builder. jsdom cannot
 * do real pointer geometry, so drag/resize math is left to the reducer
 * tests (Task 14) and the live browser walkthrough (Task 19); this file
 * covers render, click-to-select, and keyboard nudge.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import type { LabelDesign } from '../../lib/labelModel';
import EditorCanvas from './EditorCanvas';

afterEach(cleanup);

const DESIGN: LabelDesign = { size: { w: 4, h: 2 }, elements: [
  { id: 't1', type: 'text', x: 0.5, y: 0.5, w: 1.5, h: 0.25, rotation: 0,
    content: 'SN {serial_number}', fontSizePt: 10, bold: false, align: 'left' },
  { id: 'b1', type: 'barcode', x: 0.5, y: 1, w: 2, h: 0.5, rotation: 0,
    symbology: 'code128', data: '{asset_id}', showText: true },
] };

it('renders elements and the label outline', () => {
  const { container } = render(<EditorCanvas design={DESIGN} selectedId={null}
    hasTab={false} zoom={1} onSelect={() => {}} onPatch={() => {}} />);
  expect(container.querySelector('svg')).not.toBeNull();
  expect(screen.queryByText('SN {serial_number}')).not.toBeNull();
  expect(container.querySelectorAll('[data-el-id]').length).toBe(2);
});

it('click selects; clicking the background clears', async () => {
  const onSelect = vi.fn();
  const { container } = render(<EditorCanvas design={DESIGN} selectedId={null}
    hasTab={false} zoom={1} onSelect={onSelect} onPatch={() => {}} />);
  await userEvent.click(container.querySelector('[data-el-id="t1"]')!);
  expect(onSelect).toHaveBeenLastCalledWith('t1');
  await userEvent.click(container.querySelector('[data-canvas-bg]')!);
  expect(onSelect).toHaveBeenLastCalledWith(null);
});

it('arrow keys nudge the selected element by one grid step', () => {
  const onPatch = vi.fn();
  const { container } = render(<EditorCanvas design={DESIGN} selectedId="t1"
    hasTab={false} zoom={1} onSelect={() => {}} onPatch={onPatch} />);
  fireEvent.keyDown(container.querySelector('svg')!, { key: 'ArrowRight' });
  expect(onPatch).toHaveBeenCalledWith('t1', { x: 0.525 });
});
