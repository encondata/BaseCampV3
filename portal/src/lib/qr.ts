/** QR code → PNG data URL via bwip-js (already a dependency for labels). */
// Explicit subpath (rather than the bare `bwip-js` specifier), mirroring
// containerLabelAdapters.browser.ts — always resolves to the canvas-based
// browser build regardless of bundler/tsc export-condition choice.
import * as bwipjs from 'bwip-js/browser';

export function qrDataUrl(text: string, color = '000000', scale = 5): string {
  const canvas = document.createElement('canvas');
  bwipjs.toCanvas(canvas, { bcid: 'qrcode', text, scale, width: 25, height: 25, barcolor: color });
  return canvas.toDataURL('image/png');
}
