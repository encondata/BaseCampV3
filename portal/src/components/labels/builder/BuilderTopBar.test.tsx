// @vitest-environment jsdom
/**
 * The builder's top bar: the Printer button sits beside Test print and is
 * off, with the same reason, when the template isn't ZPL. Every button
 * has a hover tip (components/Tip.tsx) in place of a native `title`: the
 * label, the platform's keys, and why it's off.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import BuilderTopBar, { type BuilderTopBarProps } from './BuilderTopBar';

afterEach(cleanup);

function setup(over: Partial<BuilderTopBarProps> = {}) {
  const props: BuilderTopBarProps = {
    name: 'Vegas Destination', typeSize: 'Top · 4" x 2"', role: { kind: 'child', dpi: '300' }, version: 'v7.1',
    dirty: false, canUndo: false, canRedo: false, onUndo: vi.fn(), onRedo: vi.fn(), onBack: vi.fn(),
    onVersions: vi.fn(), onTestPrint: vi.fn(), onPrinter: vi.fn(), onSave: vi.fn(), platform: 'win', ...over,
  };
  const view = render(<div className="portal-shell"><BuilderTopBar {...props} /></div>);
  return { ...props, container: view.container };
}

/** Hover a button and read its tip: [label, keycaps, second line]. */
async function tipOf(button: HTMLElement) {
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

describe('BuilderTopBar', () => {
  it('has a Printer button beside Test print that opens the printer dialog', async () => {
    const props = setup();
    const printer = screen.getByRole('button', { name: 'Printer' });
    const testPrint = screen.getByRole('button', { name: /Test print/ });
    // each in its tip's wrapper, side by side
    expect(printer.parentElement?.nextElementSibling).toBe(testPrint.parentElement);
    expect(await tipOf(printer)).toEqual({
      label: 'Connect the USB printer, print an alignment label, check its fonts', keys: [], note: null });
    await userEvent.click(printer);
    expect(props.onPrinter).toHaveBeenCalledTimes(1);
  });

  it('turns Printer off with the Test print reason when the template is not ZPL', async () => {
    setup({ printBlocked: 'Test print is for ZPL templates.' });
    const printer = screen.getByRole('button', { name: 'Printer' }) as HTMLButtonElement;
    expect(printer.disabled).toBe(true);
    expect((await tipOf(printer)).note).toBe('Test print is for ZPL templates.');
    const testPrint = screen.getByRole('button', { name: /Test print/ }) as HTMLButtonElement;
    expect(testPrint.disabled).toBe(true);
    expect(await tipOf(testPrint)).toEqual({
      label: 'Print this label with its sample values on a USB Zebra printer', keys: ['Ctrl+P'],
      note: 'Test print is for ZPL templates.' });
  });

  it('keeps Printer on while a version is viewed read-only', () => {
    setup({ readOnly: true });
    expect((screen.getByRole('button', { name: 'Printer' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('no button keeps a native title, and every one has a tip', () => {
    const { container } = setup({ role: { kind: 'parent', dpis: ['203', '300', '600'], viewDpi: '300', onViewDpi: vi.fn() },
      onClone: vi.fn() });
    const buttons = [...container.querySelectorAll('.lbb-bar button')];
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())).toEqual([
      '← Templates', 'Show at 203 DPI', 'Show at 300 DPI', 'Show at 600 DPI', 'Undo', 'Redo', 'Versions', 'Clone',
      'Printer', 'Test print Ctrl+P', 'Save Ctrl+S']);
    for (const b of buttons) {
      expect(b.getAttribute('title'), b.textContent ?? '').toBeNull();
      expect(b.parentElement?.classList.contains('tip-trigger'), b.textContent ?? '').toBe(true);
    }
    // nor does the DPI chip around the DPI buttons
    expect(container.querySelector('.lbb-dpis')?.getAttribute('title')).toBeNull();
  });

  it('shows the platform keys: Mac vs Windows', async () => {
    setup({ platform: 'mac', canUndo: true, canRedo: true });
    expect(await tipOf(screen.getByRole('button', { name: 'Undo' }))).toEqual({ label: 'Undo', keys: ['⌘Z'], note: null });
    expect(await tipOf(screen.getByRole('button', { name: 'Redo' }))).toEqual({ label: 'Redo', keys: ['⌘⇧Z'], note: null });
    expect((await tipOf(screen.getByRole('button', { name: /Save/ }))).keys).toEqual(['⌘S']);
    cleanup();
    setup({ platform: 'win', canUndo: true, canRedo: true });
    expect((await tipOf(screen.getByRole('button', { name: 'Undo' }))).keys).toEqual(['Ctrl+Z']);
    expect((await tipOf(screen.getByRole('button', { name: 'Redo' }))).keys).toEqual(['Ctrl+Shift+Z']);
    expect((await tipOf(screen.getByRole('button', { name: /Save/ }))).keys).toEqual(['Ctrl+S']);
  });

  it('a disabled button says why it is off', async () => {
    setup({ onClone: vi.fn(), cloneBlocked: 'Save your changes first: a clone copies the saved template.' });
    const clone = screen.getByRole('button', { name: 'Clone' }) as HTMLButtonElement;
    expect(clone.disabled).toBe(true);
    expect(await tipOf(clone)).toEqual({
      label: 'Clone to a new template', keys: [], note: 'Save your changes first: a clone copies the saved template.' });
    expect((await tipOf(screen.getByRole('button', { name: 'Undo' }))).note).toBe('Nothing to undo');
    cleanup();
    setup({ readOnly: true });
    expect((await tipOf(screen.getByRole('button', { name: /Save/ }))).note).toBe('An older version is open: nothing to save.');
  });

  it('the DPI buttons and Back have tips too', async () => {
    setup({ role: { kind: 'parent', dpis: ['203', '300'], viewDpi: '300', onViewDpi: vi.fn() } });
    expect((await tipOf(screen.getByRole('button', { name: 'Show at 203 DPI' }))).label).toBe('Show at 203 DPI');
    expect((await tipOf(screen.getByRole('button', { name: '← Templates' }))).label).toBe('Back to the templates list');
    expect((await tipOf(screen.getByRole('button', { name: 'Versions' }))).label).toBe('Saved versions of this template');
  });
});
