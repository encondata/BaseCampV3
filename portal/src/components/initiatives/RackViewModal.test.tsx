import { describe, expect, it } from 'vitest';

import {
  assignLanes, FACEPLATE_USABLE_WIDTH, isRearPosition, laneGeometry, rackLabel,
} from './RackViewModal';

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

  it('does not let an unrelated collision elsewhere squeeze a lone non-colliding block (per-cluster width, not global)', () => {
    // Regression for the visual-review bug: a single-lane-case block must
    // fill the full usable width minus its lane gutter, even when some
    // OTHER pair of blocks in the same array happens to collide and need
    // two lanes. Width used to be computed once globally from the busiest
    // cluster in the whole array, so this lone block (ru 40, clear of the
    // ru-10 pair below) was wrongly squeezed to the two-lane width too.
    const blocks = [
      { id: 'lone', ru: 40, height: 4 },
      { id: 'a', ru: 10, height: 1 },
      { id: 'b', ru: 10, height: 1 }, // a and b collide with each other only
    ];
    const usableWidth = 248;
    const rects = laneGeometry(blocks, usableWidth);
    const byId = new Map(rects.map((r) => [r.id, r]));
    expect(byId.get('lone')!.width).toBe(usableWidth);
    expect(byId.get('a')!.width).toBeLessThan(usableWidth);
    expect(byId.get('b')!.width).toBeLessThan(usableWidth);
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

/* ── front/rear elevation assignment (follow-up) — a side position note
      mentioning "rear" (case-insensitive substring) sends the block to the
      REAR elevation; everything else (front, left/right, blank) stays in
      FRONT. This is also the exact predicate the component uses to decide
      whether to render a REAR elevation at all (see the last test below):
      `rows.filter((b) => isRearPosition(b.position))` empty => omit it. ── */

describe('isRearPosition', () => {
  it('matches "Rear" case-insensitively', () => {
    expect(isRearPosition('Rear')).toBe(true);
  });

  it('matches lowercase "rear"', () => {
    expect(isRearPosition('rear')).toBe(true);
  });

  it('matches "rear" as a substring (e.g. "rear-left")', () => {
    expect(isRearPosition('rear-left')).toBe(true);
  });

  it('treats "left" (and other non-rear notes) as front', () => {
    expect(isRearPosition('left')).toBe(false);
  });

  it('treats "front", blank, null, and undefined as front', () => {
    expect(isRearPosition('front')).toBe(false);
    expect(isRearPosition('')).toBe(false);
    expect(isRearPosition(null)).toBe(false);
    expect(isRearPosition(undefined)).toBe(false);
  });

  it('produces an empty rear group (the REAR elevation is omitted) when nothing is rear-mounted', () => {
    const blocks = [
      { id: 'a', position: 'front' as string | null },
      { id: 'b', position: null },
      { id: 'c', position: 'left' as string | null },
    ];
    expect(blocks.filter((b) => isRearPosition(b.position))).toHaveLength(0);
  });

  it('produces a non-empty rear group (the REAR elevation renders) when at least one asset is rear-mounted', () => {
    const blocks = [
      { id: 'a', position: 'front' as string | null },
      { id: 'b', position: 'rear' as string | null },
    ];
    expect(blocks.filter((b) => isRearPosition(b.position))).toHaveLength(1);
  });
});

/* ── per-elevation lane geometry (follow-up) — each of the two split
      elevations lays out its own blocks with FACEPLATE_USABLE_WIDTH (the
      one elevation's own interior width, not half of a shared one now
      that FRONT/REAR are two independent frames), so a front and a rear
      device at the same RU never share a lane-collision pass at all. ──── */

describe('laneGeometry with FACEPLATE_USABLE_WIDTH (per-elevation)', () => {
  it('gives a single block the elevation-interior width, not squeezed by anything', () => {
    const blocks = [{ id: 'a', ru: 10, height: 2 }];
    const [g] = laneGeometry(blocks, FACEPLATE_USABLE_WIDTH);
    expect(g.x).toBe(0);
    expect(g.width).toBe(FACEPLATE_USABLE_WIDTH);
  });

  it('tiles two overlapping blocks within one elevation without exceeding it', () => {
    const blocks = [
      { id: 'a', ru: 10, height: 2 },
      { id: 'b', ru: 10, height: 2 },
    ];
    const rects = laneGeometry(blocks, FACEPLATE_USABLE_WIDTH);
    expect(rects).toHaveLength(2);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(FACEPLATE_USABLE_WIDTH);
    }
    const [first, second] = [...rects].sort((a, b) => a.x - b.x);
    expect(first.x + first.width).toBeLessThanOrEqual(second.x);
  });
});
