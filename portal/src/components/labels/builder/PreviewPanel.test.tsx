// @vitest-environment jsdom
/**
 * The printer preview: renders on request, says when a label is too large,
 * and notes picture placeholders. QR codes need no note: the canvas, the
 * render and the print all put them at the compiler's ^FO.
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
  it('renders a design with a QR code with no note about it', async () => {
    renderWith(VEGAS());
    fireEvent.click(screen.getByRole('button', { name: 'Render' }));
    expect(await screen.findByRole('img', { name: 'The label as the printer renders it' })).toBeTruthy();
    expect(screen.queryByText(/QR code/)).toBeNull();
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

  it('asks the compile for image placeholders, and says so under a render of a design with pictures', async () => {
    const PICTURES = 'Pictures show as placeholders in the preview; the canvas and Test print use the real pictures.';
    const badge: DesignV2 = { schema: 3, size: { w: 3.375, h: 2.125 }, splits: {}, elements: [
      { id: 'image-1', type: 'image', source: 'photo', x: 0.1, y: 0.1, w: 0.8, h: 1, rotation: 0 }] };
    render(<PreviewPanel design={badge} dpi={300} samples={{ 'person:id': 'p-1' }} library={[]} sizeKey="id-badge"
      labelType="id_badge" />);
    expect(screen.queryByText(PICTURES)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Render' }));
    expect(await screen.findByRole('img', { name: 'The label as the printer renders it' })).toBeTruthy();
    expect(api.compileLabel).toHaveBeenCalledWith(expect.objectContaining({ image_mode: 'placeholder' }));
    expect(screen.getByText(PICTURES)).toBeTruthy();
    cleanup();
    // no pictures: no note (the request still asks for placeholders)
    renderWith(VEGAS());
    fireEvent.click(screen.getByRole('button', { name: 'Render' }));
    expect(await screen.findByRole('img', { name: 'The label as the printer renders it' })).toBeTruthy();
    expect(api.compileLabel).toHaveBeenLastCalledWith(expect.objectContaining({ image_mode: 'placeholder' }));
    expect(screen.queryByText(PICTURES)).toBeNull();
  });
});
