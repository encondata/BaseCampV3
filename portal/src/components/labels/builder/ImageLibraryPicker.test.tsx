// @vitest-environment jsdom
/**
 * The label image library picker on its own: an upload that lands after
 * the panel moved on picks through the latest callback, for the elements
 * it was started for, and not at all once the picker is gone; a refused
 * upload says what was wrong (a control character in the file's name is
 * not a file-type problem).
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type LabelImage } from '../../../lib/api';
import ImageLibraryPicker from './ImageLibraryPicker';

const api = vi.hoisted(() => ({ listLabelImages: vi.fn(), uploadLabelImage: vi.fn(), deleteLabelImage: vi.fn() }));
vi.mock('../../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../../lib/api')>()), ...api,
}));

const MADE: LabelImage = { id: 'img-new', name: 'Cumulus', width: 600, height: 200, mime: 'image/png', created_at: '' };

beforeEach(() => {
  api.listLabelImages.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ImageLibraryPicker: an upload that lands later', () => {
  async function startUpload(onPick: (id: string, target: readonly string[]) => void) {
    let finish!: (made: LabelImage) => void;
    api.uploadLabelImage.mockReturnValue(new Promise<LabelImage>((resolve) => { finish = resolve; }));
    const utils = render(<ImageLibraryPicker value={null} target={['image-1']} onPick={onPick} />);
    await waitFor(() => expect(api.listLabelImages).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Image file'),
      { target: { files: [new File(['png'], 'Cumulus.png', { type: 'image/png' })] } });
    await waitFor(() => expect(api.uploadLabelImage).toHaveBeenCalled());
    return { ...utils, finish: async () => { await act(async () => { finish(MADE); }); } };
  }

  it('picks through the latest onPick, for the elements it began for', async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender, finish } = await startUpload(first);
    rerender(<ImageLibraryPicker value={null} target={['image-2']} onPick={latest} />);
    await finish();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith('img-new', ['image-1']);
  });

  it('picks nothing once the picker is gone', async () => {
    const onPick = vi.fn();
    const { unmount, finish } = await startUpload(onPick);
    unmount();
    await finish();
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('ImageLibraryPicker: a refused upload', () => {
  const FILE_TYPE = 'That file isn’t a picture a label can use: a PNG, JPEG, WebP or GIF of 40 megapixels at most.';

  async function refusedWith(err: ApiError): Promise<string | null> {
    api.uploadLabelImage.mockRejectedValue(err);
    render(<ImageLibraryPicker value={null} target={['image-1']} onPick={vi.fn()} />);
    await waitFor(() => expect(api.listLabelImages).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Image file'),
      { target: { files: [new File(['png'], 'Cumulus\t.png', { type: 'image/png' })] } });
    return (await screen.findByRole('alert')).textContent;
  }

  it('names a control character in the file’s name', async () => {
    expect(await refusedWith(new ApiError(422, 'bad_field',
      { code: 'bad_field', field: 'name', message: 'the name holds a control character' })))
      .toBe('The file’s name has a control character in it. Rename the file and upload it again.');
  });

  it.each(['empty_file', 'invalid_file_type', 'unreadable_image', 'image_too_large'])(
    'keeps the file-type sentence for %s', async (code) => {
      expect(await refusedWith(new ApiError(422, code, { code }))).toBe(FILE_TYPE);
    },
  );
});
