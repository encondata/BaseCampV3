/**
 * Browser adapters for the container label sheet — a direct port of V2's
 * `generateBarcode`, `generateQRCode`, and `loadImageAsDataUrl` helpers
 * (portal-v2/src/pages/ContainerLabels.jsx, lines 63-105), plus a
 * `loadTagImages` helper that mirrors the tag-image-cache loop from
 * `handleGenerate` (lines 243-255).
 */
// Explicit subpath (rather than the bare `bwip-js` specifier V2 used) so
// resolution is unambiguous regardless of which export condition the
// bundler or tsc applies — this always gets the canvas-based browser build.
import * as bwipjs from 'bwip-js/browser';

import type { Adapters, TagDefinition, TagKey } from './containerLabelSheet';
import { TAG_TYPES } from './containerLabelSheet';

// Generate a barcode as a data URL using bwip-js
function generateBarcode(text: string): string {
  const canvas = document.createElement('canvas');
  bwipjs.toCanvas(canvas, {
    bcid: 'code128',
    text,
    scale: 3,
    height: 15,
    includetext: false,
  });
  return canvas.toDataURL('image/png');
}

// Generate a QR code as a data URL using bwip-js
function generateQRCode(text: string, color = '000000'): string {
  const canvas = document.createElement('canvas');
  bwipjs.toCanvas(canvas, {
    bcid: 'qrcode',
    text,
    scale: 5,
    width: 25,
    height: 25,
    barcolor: color,
  });
  return canvas.toDataURL('image/png');
}

export const browserContainerLabelAdapters: Adapters = {
  barcode: generateBarcode,
  qr: generateQRCode,
};

// Load an image from a URL and return a data URL
export function loadImageAsDataUrl(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = src;
  });
}

/** Loads the tag images actually in use, mirroring V2's `tagImageCache`
 *  loop: only tags with an image are fetched, and a failed load is dropped
 *  (logged) rather than aborting the whole generate. */
export async function loadTagImages(tags: Iterable<TagKey>): Promise<Partial<Record<TagKey, string>>> {
  const usedTagTypes = new Set(tags);
  const tagImageCache: Partial<Record<TagKey, string>> = {};
  for (const tagType of usedTagTypes) {
    const tagDef: TagDefinition | undefined = TAG_TYPES[tagType];
    if (tagDef?.image) {
      try {
        tagImageCache[tagType] = await loadImageAsDataUrl(tagDef.image);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`Failed to load ${tagType} tag image:`, err);
      }
    }
  }
  return tagImageCache;
}
