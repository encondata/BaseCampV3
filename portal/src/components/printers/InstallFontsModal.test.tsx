// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LabelFont } from '../../lib/api';
import InstallFontsModal, { fontStates } from './InstallFontsModal';

afterEach(cleanup);

const font = (id: string, name: string, used: string[] = []): LabelFont => ({
  id, name, display_name: name.toLowerCase(), size_bytes: 124336, content_type: 'font/ttf', uploaded_by: 'p',
  uploaded_by_name: 'Jimmy', created_at: new Date(Date.now() - 3_600_000).toISOString(),
  used_by: used.map((t) => ({ template_id: t, template_name: t })),
});
const LIB = [font('f1', '85620388.TTF', ['Front Asset Tag']), font('f2', 'ARIAL_B.TTF')];
const DIR = '\x02- DIR E:*.*\r\n* 85620388.TTF       124336\r\n* TT0003M_.TTF      169188\r\n-1928576 bytes free E: ONBOARD FLASH\r\n\x03';

function fakePrinter(connected = true) {
  return {
    connected,
    query: vi.fn(async (_cmd: string) => DIR),
    send: vi.fn(async (_zpl: string) => undefined),
    sendBytes: vi.fn(async (bytes: Uint8Array, onProgress?: (s: number, t: number) => void) => { onProgress?.(bytes.length, bytes.length); }),
  };
}

function setup(over: Partial<Parameters<typeof InstallFontsModal>[0]> = {}) {
  const printer = fakePrinter();
  const h = {
    onUpload: vi.fn(async (_f: File, _n: string) => undefined), onDeleteFont: vi.fn(async (_id: string) => undefined),
    onFetchBytes: vi.fn(async (_id: string) => new Uint8Array([0, 1, 0, 0, 7, 7])), onClose: vi.fn(),
  };
  render(<InstallFontsModal printer={printer} fonts={LIB} canAdd canDelete {...h} {...over} />);
  return { printer, ...h };
}

describe('fontStates', () => {
  it('classifies library fonts and printer-only objects', () => {
    const listing = { objects: [{ name: '85620388.TTF', bytes: 1 }, { name: 'TT0003M_.TTF', bytes: 2 }], bytesFree: 9 };
    expect(fontStates(LIB, listing)).toEqual({
      library: { '85620388.TTF': 'installed', 'ARIAL_B.TTF': 'missing' },
      printerOnly: [{ name: 'TT0003M_.TTF', bytes: 2 }],
    });
    expect(fontStates(LIB, null).library).toEqual({});
  });
});

describe('InstallFontsModal', () => {
  it('lists the library with usage, reads the printer directory, and shows states', async () => {
    const { printer } = setup();
    expect(screen.getByText('Install fonts')).toBeTruthy();
    expect(screen.getByText('Front Asset Tag')).toBeTruthy();
    await waitFor(() => expect(printer.query).toHaveBeenCalledWith('^XA^HWE:*.*^XZ'));
    expect(await screen.findByText('Installed')).toBeTruthy();
    expect(screen.getByText('Missing')).toBeTruthy();
    expect(screen.getByText('Printer only')).toBeTruthy();
    expect(screen.getByText(/1,883 KB free|1883 KB free/)).toBeTruthy();
  });
  it('installs a missing font: header, bytes, then re-reads the directory', async () => {
    const { printer, onFetchBytes } = setup();
    await screen.findByText('Missing');
    const row = screen.getByText('ARIAL_B.TTF').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(printer.sendBytes).toHaveBeenCalled());
    expect(onFetchBytes).toHaveBeenCalledWith('f2');
    expect(printer.send).toHaveBeenCalledWith('~DYE:ARIAL_B.TTF,B,T,6,,');
    await waitFor(() => expect(printer.query.mock.calls.filter((c) => c[0] === '^XA^HWE:*.*^XZ').length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText('Installed ✓')).toBeTruthy();
  });
  it('Install all missing installs every missing library font', async () => {
    const { printer } = setup();
    await screen.findByText('Missing');
    await userEvent.click(screen.getByRole('button', { name: 'Install all missing' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('~DYE:ARIAL_B.TTF,B,T,6,,'));
    expect(printer.send.mock.calls.filter((c) => String(c[0]).startsWith('~DY')).length).toBe(1);
  });
  it('removes an object from the printer', async () => {
    const { printer } = setup();
    await screen.findByText('Printer only');
    const row = screen.getByText('TT0003M_.TTF').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Remove from printer' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA^IDE:TT0003M_.TTF^XZ'));
  });
  it('uploads a TTF with a validated name and blocks bad names', async () => {
    const { onUpload } = setup();
    const input = screen.getByLabelText('TrueType font file') as HTMLInputElement;
    const file = new File([new Uint8Array([0, 1, 0, 0, 1])], 'Swiss721.ttf', { type: 'font/ttf' });
    await userEvent.upload(input, file);
    const name = screen.getByLabelText('Printer name') as HTMLInputElement;
    expect(name.value).toBe('SWISS721.TTF');
    fireEvent.change(name, { target: { value: 'too long name.ttf' } });
    expect(screen.getByText('Use up to 8 letters, digits, or underscores plus .TTF')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Upload' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: '85620388.TTF' } });
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(onUpload).toHaveBeenCalledWith(file, '85620388.TTF');
  });
  it('removes a library font after inline confirmation', async () => {
    const { onDeleteFont } = setup();
    const row = screen.getByText('ARIAL_B.TTF').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Remove ARIAL_B.TTF from the library? Printers keep their copy.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    expect(onDeleteFont).toHaveBeenCalledWith('f2');
  });
  it('without a printer the install column explains and hides install buttons', () => {
    setup({ printer: fakePrinter(false) });
    expect(screen.getByText('Connect a printer to install fonts.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });
  it('hides upload/remove without permissions', () => {
    setup({ canAdd: false, canDelete: false });
    expect(screen.queryByLabelText('TrueType font file')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
  it('reads the printer directory once on mount and only re-reads on connect/disconnect, not on every parent re-render', async () => {
    const printer = fakePrinter();
    const h = {
      onUpload: vi.fn(async (_f: File, _n: string) => undefined), onDeleteFont: vi.fn(async (_id: string) => undefined),
      onFetchBytes: vi.fn(async (_id: string) => new Uint8Array([0, 1, 0, 0, 7, 7])), onClose: vi.fn(),
    };
    const { rerender } = render(<InstallFontsModal printer={printer} fonts={LIB} canAdd canDelete {...h} />);
    await waitFor(() => expect(printer.query).toHaveBeenCalledWith('^XA^HWE:*.*^XZ'));
    const dirCalls = () => printer.query.mock.calls.filter((c) => c[0] === '^XA^HWE:*.*^XZ').length;
    expect(dirCalls()).toBe(1);

    // Parent re-renders with a brand-new printer object each time (same fns, new identity,
    // same connected) must not re-trigger the directory read.
    for (let i = 0; i < 3; i++) {
      rerender(<InstallFontsModal printer={{ ...printer }} fonts={LIB} canAdd canDelete {...h} />);
    }
    expect(dirCalls()).toBe(1);

    // A connect/disconnect transition should re-trigger exactly one more read.
    rerender(<InstallFontsModal printer={{ ...printer, connected: false }} fonts={LIB} canAdd canDelete {...h} />);
    rerender(<InstallFontsModal printer={{ ...printer, connected: true }} fonts={LIB} canAdd canDelete {...h} />);
    await waitFor(() => expect(dirCalls()).toBe(2));
  });
});
