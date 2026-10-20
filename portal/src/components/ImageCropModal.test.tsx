// @vitest-environment jsdom
/**
 * The crop step every avatar and logo upload goes through: the square it
 * saves is painted white first, so a transparent PNG's clear areas come
 * out white in the JPEG (JPEG has no alpha: unpainted pixels were black,
 * and a badge's thresholded logo printed as a black square).
 *
 * jsdom has no 2D canvas: the test stands in a context that records each
 * call and the fill style in force when it was made.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ImageCropModal from './ImageCropModal';

type Call = { op: string; args: unknown[]; fillStyle: string };
let calls: Call[] = [];

beforeEach(() => {
  calls = [];
  URL.createObjectURL = vi.fn(() => 'blob:picture');
  URL.revokeObjectURL = vi.fn();
  HTMLCanvasElement.prototype.getContext = vi.fn(function getContext() {
    const ctx = {
      fillStyle: '#000000',
      imageSmoothingQuality: 'low',
      fillRect: (...args: unknown[]) => { calls.push({ op: 'fillRect', args, fillStyle: ctx.fillStyle }); },
      drawImage: (...args: unknown[]) => { calls.push({ op: 'drawImage', args, fillStyle: ctx.fillStyle }); },
    };
    return ctx;
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toBlob = vi.fn(function toBlob(cb: BlobCallback, type?: string) {
    cb(new Blob(['jpeg'], { type }));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function saveCrop(outputSize = 512) {
  const onSave = vi.fn<(blob: Blob) => void>();
  const file = new File(['png'], 'logo.png', { type: 'image/png' });
  const { container } = render(<ImageCropModal file={file} outputSize={outputSize} onCancel={vi.fn()} onSave={onSave} />);
  const img = await waitFor(() => {
    const el = container.querySelector('img');
    expect(el).not.toBeNull();
    return el!;
  });
  Object.defineProperty(img, 'naturalWidth', { value: 600, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: 300, configurable: true });
  fireEvent.load(img);
  const save = screen.getByRole('button', { name: 'Save photo' }) as HTMLButtonElement;
  await waitFor(() => expect(save.disabled).toBe(false));
  fireEvent.click(save);
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  return onSave.mock.calls[0][0];
}

describe('ImageCropModal', () => {
  it('paints the square white before drawing the picture over it', async () => {
    const blob = await saveCrop(256);
    expect(calls.map((c) => c.op)).toEqual(['fillRect', 'drawImage']);
    const [fill] = calls;
    expect(fill.fillStyle.toLowerCase()).toMatch(/^(#fff|#ffffff|white)$/);
    expect(fill.args).toEqual([0, 0, 256, 256]);
    // drawn into the whole square
    expect(calls[1].args.slice(5)).toEqual([0, 0, 256, 256]);
    expect(blob.type).toBe('image/jpeg');
  });
});
