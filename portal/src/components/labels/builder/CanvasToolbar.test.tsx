// @vitest-environment jsdom
/**
 * The canvas toolbar's hover tips (components/Tip.tsx): every button has
 * one in place of a native `title`, with the label and the platform's keys
 * as keycaps; an align button that's off says how many to select.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Platform } from '../../../labels/builder/shortcuts';
import CanvasToolbar, { type CanvasToolbarProps } from './CanvasToolbar';

afterEach(cleanup);

function setup(over: Partial<CanvasToolbarProps> = {}) {
  const props: CanvasToolbarProps = {
    tool: 'select', onTool: vi.fn(), zoom: 1, onZoom: vi.fn(),
    view: { zoom: 1, grid: true, snap: false, rulers: true, showSamples: false },
    onView: vi.fn(), selectionCount: 0, onAlign: vi.fn(), platform: 'mac', ...over,
  };
  return render(<div className="portal-shell"><CanvasToolbar {...props} /></div>);
}

/** Hover a button and read its tip: [label, keycaps, second line]. */
async function tipOf(name: string) {
  const button = screen.getByRole('button', { name });
  await userEvent.hover(button);
  const tip = await screen.findByRole('tooltip');
  const read = {
    label: tip.querySelector('.tip-label')?.textContent,
    keys: [...tip.querySelectorAll('kbd')].map((k) => k.textContent),
    note: tip.querySelector('.tip-note')?.textContent ?? null,
  };
  await userEvent.unhover(button);
  return read;
}

describe('CanvasToolbar tips', () => {
  it('no toolbar button keeps a native title, and every one has a tip', () => {
    const { container } = setup();
    const buttons = [...container.querySelectorAll('.lbc-toolbar button')];
    expect(buttons.length).toBeGreaterThan(20);
    for (const b of buttons) {
      expect(b.getAttribute('title'), b.getAttribute('aria-label') ?? b.textContent ?? '').toBeNull();
      expect(b.parentElement?.classList.contains('tip-trigger'), b.textContent ?? '').toBe(true);
    }
  });

  it.each<[Platform, string, string, string]>([
    ['mac', 'Text', 'Text', 'T'],
    ['mac', 'Zoom out', 'Zoom out', '⌘-'],
    ['win', 'Zoom out', 'Zoom out', 'Ctrl+-'],
    ['mac', 'Fit', 'Zoom to fit', '⌘0'],
    ['win', 'True size', 'True size, one dot a pixel', 'Shift+0'],
    ['mac', 'Snap', 'Snap off', "⌘⇧'"],
    ['win', 'Grid', 'Grid on', "Ctrl+'"],
    ['win', 'Sample values', 'Sample values', 'Ctrl+E'],
  ])('%s: %s shows its label and keys', async (platform, name, label, keys) => {
    setup({ platform });
    expect(await tipOf(name)).toEqual({ label, keys: [keys], note: null });
  });

  it('an align button says what it lines up on, or how many to select', async () => {
    setup({ selectionCount: 2, platform: 'win' });
    expect(await tipOf('Align left')).toEqual({
      label: 'Align left edges to the first selected', keys: ['Alt+A'], note: null });
    expect(await tipOf('Match width')).toEqual({
      label: 'Match the first selected’s width', keys: [], note: null });
    expect(await tipOf('Distribute horizontally')).toEqual({
      label: 'Distribute horizontally', keys: ['Shift+Alt+H'], note: 'Select three or more elements' });
    cleanup();
    setup({ selectionCount: 0, platform: 'mac' });
    expect((await tipOf('Align left')).note).toBe('Select one or more elements');
    expect((await tipOf('Match height')).note).toBe('Select two or more elements');
  });

  it('a read-only view says why the tools are off', async () => {
    setup({ readOnly: true, selectionCount: 2 });
    expect((await tipOf('Box')).note).toBe('An older version is open.');
    expect((await tipOf('Select')).note).toBeNull();
    expect((await tipOf('Align left')).note).toBe('An older version is open.');
  });
});
