import { describe, expect, it } from 'vitest';

import { clampView, FIT, MAX_SCALE, zoomAt, type ZoomView } from './zoomView';

const stage = { width: 1000, height: 800 };
const image = { width: 800, height: 600 }; // its size at scale 1 (fit)

describe('zoomAt', () => {
  it('keeps the point under the cursor still while zooming', () => {
    const point = { x: 200, y: -100 }; // from the stage's center
    const next = zoomAt(FIT, 2, point);
    // the image point that was under the cursor: (point - t) / s
    const before = { x: (point.x - FIT.x) / FIT.scale, y: (point.y - FIT.y) / FIT.scale };
    expect(next.x + before.x * next.scale).toBeCloseTo(point.x);
    expect(next.y + before.y * next.scale).toBeCloseTo(point.y);
    expect(next.scale).toBe(2);
  });

  it('never zooms out past fit or in past the maximum', () => {
    expect(zoomAt({ scale: 2, x: 50, y: 50 }, 0.2, { x: 0, y: 0 })).toEqual(FIT);
    expect(zoomAt(FIT, 99, { x: 0, y: 0 }).scale).toBe(MAX_SCALE);
  });
});

describe('clampView', () => {
  it('centers the image at fit, whatever the pan', () => {
    expect(clampView({ scale: 1, x: 300, y: -40 }, image, stage)).toEqual(FIT);
  });

  it('lets a zoomed image pan only until its edge reaches the stage edge', () => {
    // at 2x the image is 1600 x 1200: 300 px spare each side across, 200 up/down
    const v: ZoomView = clampView({ scale: 2, x: 900, y: -900 }, image, stage);
    expect(v).toEqual({ scale: 2, x: 300, y: -200 });
  });

  it('keeps a dimension that still fits centered', () => {
    const tall = { width: 300, height: 700 };
    // at 1.1x: 330 wide (fits, so centered), 770 tall (fits too)
    expect(clampView({ scale: 1.1, x: 80, y: 80 }, tall, stage)).toEqual({ scale: 1.1, x: 0, y: 0 });
  });
});
