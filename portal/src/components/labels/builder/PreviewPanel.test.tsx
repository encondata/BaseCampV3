// @vitest-environment jsdom
/**
 * The printer preview: a design with a QR code gets a note under the
 * render, since Labelary draws a ^BQ symbol about 0.2 in higher than a
 * Zebra prints it (the compiler sets ^FO for the printer).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesignV2 } from '../../../labels/builder/model';
import { SAMPLES, VEGAS } from './builderTestKit';

const api = vi.hoisted(() => ({ compileLabel: vi.fn(), previewZplRequest: vi.fn() }));
vi.mock('../../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../../lib/api')>()), ...api,
}));

const { default: PreviewPanel } = await import('./PreviewPanel');

const NOTE = 'The preview shows QR codes about 0.2 in higher than the printer; the canvas is right.';

beforeEach(() => {
  api.compileLabel.mockResolvedValue({ code: '^XA^XZ' });
  api.previewZplRequest.mockResolvedValue(new Blob(['png']));
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

function renderWith(design: DesignV2) {
  render(<PreviewPanel design={design} dpi={300} samples={SAMPLES} library={[]} sizeKey="4x2" labelType="top" />);
}

describe('PreviewPanel', () => {
  it('notes the QR offset under a render of a design with a QR code', async () => {
    renderWith(VEGAS());
    expect(screen.queryByText(NOTE)).toBeNull();   // nothing rendered yet
    fireEvent.click(screen.getByRole('button', { name: 'Render' }));
    expect(await screen.findByRole('img', { name: 'The label as the printer renders it' })).toBeTruthy();
    expect(screen.getByText(NOTE)).toBeTruthy();
  });

  it('says nothing about QR codes when the design has none', async () => {
    const d = VEGAS();
    renderWith({ ...d, elements: d.elements.filter((e) => e.type !== 'qr' && !(e.type === 'field' && e.display === 'qr')) });
    fireEvent.click(screen.getByRole('button', { name: 'Render' }));
    expect(await screen.findByRole('img', { name: 'The label as the printer renders it' })).toBeTruthy();
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});
