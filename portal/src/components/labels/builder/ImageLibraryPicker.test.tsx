// @vitest-environment jsdom
/**
 * The label image library picker on its own: an upload that lands after
 * the panel moved on picks through the latest callback, for the elements
 * it was started for, and not at all once the picker is gone.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LabelImage } from '../../../lib/api';
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
