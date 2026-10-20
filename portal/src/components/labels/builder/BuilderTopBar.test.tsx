// @vitest-environment jsdom
/**
 * The builder's top bar: the Printer button sits beside Test print and is
 * off, with the same reason, when the template isn't ZPL.
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
  render(<BuilderTopBar {...props} />);
  return props;
}

describe('BuilderTopBar', () => {
  it('has a Printer button beside Test print that opens the printer dialog', async () => {
    const props = setup();
    const printer = screen.getByRole('button', { name: 'Printer' });
    const testPrint = screen.getByRole('button', { name: /Test print/ });
    expect(printer.nextElementSibling).toBe(testPrint);
    expect(printer.getAttribute('title')).toBe('Connect the USB printer, print an alignment label, check its fonts');
    await userEvent.click(printer);
    expect(props.onPrinter).toHaveBeenCalledTimes(1);
  });

  it('turns Printer off with the Test print reason when the template is not ZPL', () => {
    setup({ printBlocked: 'Test print is for ZPL templates.' });
    const printer = screen.getByRole('button', { name: 'Printer' }) as HTMLButtonElement;
    expect(printer.disabled).toBe(true);
    expect(printer.getAttribute('title')).toBe('Test print is for ZPL templates.');
  });

  it('keeps Printer on while a version is viewed read-only', () => {
    setup({ readOnly: true });
    expect((screen.getByRole('button', { name: 'Printer' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
