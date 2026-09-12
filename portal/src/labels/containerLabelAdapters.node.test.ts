import { describe, expect, it } from 'vitest';

import { createNodeContainerLabelAdapters, readTagImages } from './containerLabelAdapters.node';
import type { ContainerLabelInput } from './containerLabelSheet';

const PNG_MAGIC = '89504e470d0a1a0a';

function dataUrlBytes(dataUrl: string): Buffer {
  const [, base64] = dataUrl.split(',');
  return Buffer.from(base64, 'base64');
}

describe('createNodeContainerLabelAdapters', () => {
  it('renders a code128 barcode and a qrcode as PNG data URLs, using the V2 option objects', async () => {
    const input: ContainerLabelInput = {
      move: { id: 'move-1', name: 'NAP11 Migration', sourceSite: null, destSite: null, scheduledStart: null },
      containers: [{ id: 'c1', name: 'Rack A Contents', tag: 'vendor' }],
      tagImages: {},
    };

    const adapters = await createNodeContainerLabelAdapters(input);
    const barcodeUrl = adapters.barcode('Rack A Contents');
    const qrUrl = adapters.qr('Rack A Contents', '1890ff');

    expect(barcodeUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(qrUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(dataUrlBytes(barcodeUrl).subarray(0, 8).toString('hex')).toBe(PNG_MAGIC);
    expect(dataUrlBytes(qrUrl).subarray(0, 8).toString('hex')).toBe(PNG_MAGIC);
  });

  it('throws for a barcode/QR request that was not pre-rendered from the input', async () => {
    const input: ContainerLabelInput = {
      move: { id: 'move-1', name: null, sourceSite: null, destSite: null, scheduledStart: null },
      containers: [{ id: 'c1', name: 'Rack A Contents', tag: null }],
      tagImages: {},
    };
    const adapters = await createNodeContainerLabelAdapters(input);
    expect(() => adapters.barcode('Some Other Name')).toThrow();
    expect(() => adapters.qr('Rack A Contents', 'CC0000')).toThrow();
  });
});

describe('readTagImages', () => {
  const imagesDir = new URL('../../public/images', import.meta.url).pathname;

  it('reads only the requested tags that have an image, as base64 PNG data URLs', () => {
    const images = readTagImages(imagesDir, ['priority', 'vendor', 'none']);
    expect(Object.keys(images).sort()).toEqual(['priority', 'vendor']);
    expect(images.priority?.startsWith('data:image/png;base64,')).toBe(true);
    expect(dataUrlBytes(images.priority as string).subarray(0, 8).toString('hex')).toBe(PNG_MAGIC);
  });
});
