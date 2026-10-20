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
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

  it('a label too large to render (a big picture at a high DPI) says so, without asking Labelary', async () => {
    api.compileLabel.mockResolvedValue({ code: `^XA${'A'.repeat(250_000)}^XZ` });
    renderWith(VEGAS());
    fireEvent.click(screen.getByRole('button', { name: 'Render' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Too large to preview at this DPI.');
    expect(api.previewZplRequest).not.toHaveBeenCalled();
  });

  it('a preview the server refuses for its length says the same', async () => {
    const { ApiError } = await import('../../../lib/api');
    api.previewZplRequest.mockRejectedValue(new ApiError(422, 'unknown_error',
      [{ loc: ['body', 'zpl'], type: 'string_too_long', msg: 'String should have at most 20000 characters' }]));
    renderWith(VEGAS());
    fireEvent.click(screen.getByRole('button', { name: 'Render' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Too large to preview at this DPI.');
  });

  it('a compile refused for a picture says why in a sentence, not its code', async () => {
    const { ApiError } = await import('../../../lib/api');
    for (const [code, said] of [
      ['person_not_found', 'The sample person is no longer on file. Load another or clear the sample person.'],
      ['storage_unavailable', 'The pictures can’t be loaded right now. Try again in a moment.'],
      ['images_badge_only', 'Can’t print: images print on ID Badge templates in ZPL only.'],
      ['image_too_large', 'A picture is too large at this DPI. Make its box smaller.'],
    ]) {
      api.compileLabel.mockRejectedValueOnce(new ApiError(422, code));
      renderWith(VEGAS());
      fireEvent.click(screen.getByRole('button', { name: 'Render' }));
      expect((await screen.findByRole('alert')).textContent).toBe(said);
      cleanup();
    }
  });

  it('says nothing about QR codes when the design has none', async () => {
    const d = VEGAS();
    renderWith({ ...d, elements: d.elements.filter((e) => e.type !== 'qr' && !(e.type === 'field' && e.display === 'qr')) });
    fireEvent.click(screen.getByRole('button', { name: 'Render' }));
    expect(await screen.findByRole('img', { name: 'The label as the printer renders it' })).toBeTruthy();
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});
