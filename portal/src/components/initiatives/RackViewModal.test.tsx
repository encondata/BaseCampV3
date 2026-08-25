import { describe, expect, it } from 'vitest';

import { assignLanes, laneGeometry, rackLabel } from './RackViewModal';

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

/* ── rack faceplate label format (redesign) — one line, `name (position)`
      when the side has a position note, else just the name, truncated to
      fit the faceplate's lane width. ─────────────────────────────────── */

describe('rackLabel', () => {
  it('returns just the name when there is no position note', () => {
    expect(rackLabel('w1-hs4-m0407', undefined, 200)).toBe('w1-hs4-m0407');
    expect(rackLabel('w1-hs4-m0407', null, 200)).toBe('w1-hs4-m0407');
  });

  it('appends the position in parens on one line when present', () => {
    expect(rackLabel('w1-hs4-m0407', 'rear', 200)).toBe('w1-hs4-m0407 (rear)');
  });

  it('leaves short labels untouched when they fit the lane width', () => {
    expect(rackLabel('short', 'rear', 200)).toBe('short (rear)');
  });

  it('truncates with an ellipsis to fit a narrow lane width', () => {
    // laneWidth 40 / 5.2px per char -> budget of 7 chars, so the full
    // "very-long-name-here (rear)" string must be cut down.
    const result = rackLabel('very-long-name-here', 'rear', 40);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBe(7); // floor(40 / 5.2) === 7 char budget
  });

  it('returns the untruncated label when given an unbounded lane width', () => {
    expect(rackLabel('very-long-name-here', 'rear', Infinity))
      .toBe('very-long-name-here (rear)');
  });

  it('never returns an empty string, even for a near-zero lane width', () => {
    const result = rackLabel('anything', 'rear', 0);
    expect(result.length).toBeGreaterThan(0);
  });
});
