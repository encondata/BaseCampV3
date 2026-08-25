import { describe, expect, it } from 'vitest';

import { assignLanes, laneGeometry } from './RackViewModal';

/* ── rack view collision layout (Task 6 fix-round) — laneGeometry is the
      pure geometry math behind the SVG's overlapping-block handling; tested
      directly here without mounting the component/SVG. The bug this guards
      against: dividing usableWidth ACROSS lanes, not just subtracting the
      gutters off the front, so a second colliding lane doesn't push a block
      past the right edge of the frame. ────────────────────────────────── */

describe('laneGeometry', () => {
  it('keeps a single (non-colliding) block spanning the full usable width', () => {
    const blocks = [{ id: 'a', ru: 10, height: 2 }];
    const [g] = laneGeometry(blocks, 248);
    expect(g.x).toBe(0);
    expect(g.width).toBe(248);
  });

  it('tiles two overlapping blocks side by side, both fully inside the frame', () => {
    // Same RU range on both — this is exactly the reviewer-reported case
    // (usableWidth=248, 2 lanes): before the fix, lane 1's rect landed at
    // x=304 width=234 (right edge 538) — far past the 320-wide viewBox.
    const blocks = [
      { id: 'a', ru: 10, height: 2 },
      { id: 'b', ru: 10, height: 2 },
    ];
    const usableWidth = 248;
    const rects = laneGeometry(blocks, usableWidth);
    expect(rects).toHaveLength(2);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(usableWidth);
    }
    // and they shouldn't overlap each other horizontally
    const [first, second] = [...rects].sort((a, b) => a.x - b.x);
    expect(first.x + first.width).toBeLessThanOrEqual(second.x);
  });

  it('tiles three overlapping blocks into three lanes, all inside the frame', () => {
    const blocks = [
      { id: 'a', ru: 10, height: 1 },
      { id: 'b', ru: 10, height: 1 },
      { id: 'c', ru: 10, height: 1 },
    ];
    const usableWidth = 248;
    const rects = laneGeometry(blocks, usableWidth);
    expect(new Set(rects.map((r) => r.x)).size).toBe(3); // three distinct lanes
    for (const r of rects) {
      expect(r.x + r.width).toBeLessThanOrEqual(usableWidth);
    }
  });

  it('does not collide non-overlapping blocks into separate lanes', () => {
    const blocks = [
      { id: 'a', ru: 10, height: 1 },
      { id: 'b', ru: 20, height: 1 }, // well clear of a's range
    ];
    const lanes = assignLanes(blocks);
    expect(lanes.get('a')).toBe(0);
    expect(lanes.get('b')).toBe(0);
  });
});
