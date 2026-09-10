import { rackRuCount, DEFAULT_RU_COUNT } from './RackElevation';
import { describe, expect, it } from 'vitest';

import {
  assignLanes, FACEPLATE_USABLE_WIDTH, ghostBlocksFor, isRearPosition, laneGeometry,
  rackLabel, tooltipRows,
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
      that FRONT/REAR are two independent frames). A front and a rear
      device at the same RU are never in the SAME array of real blocks —
      each elevation instead sees the other's device as its own ghost (see
      `ghostBlocksFor` below), which still lane-splits against it locally. */

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

/* ── cross-side ghost blocks (round 3) — every elevation shows a blank
      "ghost" for each asset actually mounted on the OPPOSITE physical
      side, same RU/height, so occupied space reads correctly from both
      faces. `ghostBlocksFor` is the pure mapping from "the other side's
      real blocks" to "this elevation's ghost blocks" — id-preserving (so
      hovering a ghost resolves the same underlying row) and tagged so the
      renderer can style/skip-label them differently from real blocks. ── */

describe('ghostBlocksFor', () => {
  it('returns an empty list for an empty source (nothing on the opposite side)', () => {
    expect(ghostBlocksFor([])).toEqual([]);
  });

  it('mirrors each source block with the same id/ru/height/position, tagged isGhost', () => {
    const source = [
      { id: 'a', label: 'server-a', ru: 12, height: 2, verified: true, position: 'rear',
        categoryLabel: null, categoryColor: null, makeModel: '' },
    ];
    const ghosts = ghostBlocksFor(source);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]).toMatchObject({
      id: 'a', ru: 12, height: 2, position: 'rear', isGhost: true,
    });
  });

  it('preserves the source array length and each id 1:1 for multiple blocks', () => {
    const source = [
      { id: 'a', label: 'x', ru: 1, height: 1, verified: false, position: null,
        categoryLabel: null, categoryColor: null, makeModel: '' },
      { id: 'b', label: 'y', ru: 5, height: 1, verified: true, position: 'front',
        categoryLabel: null, categoryColor: null, makeModel: '' },
    ];
    const ghosts = ghostBlocksFor(source);
    expect(ghosts.map((g) => g.id)).toEqual(['a', 'b']);
    expect(ghosts.every((g) => g.isGhost)).toBe(true);
  });
});

/* ── hover tooltip rows (round 3) — Serial/Make-Model/RU always show;
      Position is omitted when the note is blank or just "front", since
      that's the unmarked default and wouldn't add information a plain
      faceplate on the FRONT elevation doesn't already convey. ────────── */

describe('tooltipRows', () => {
  const base = { serial: 'SN-1', makeModel: 'Dell R640', ru: 12 };

  it('always includes Serial, Make/Model, and RU, in that order', () => {
    const rows = tooltipRows({ ...base, position: null });
    expect(rows.map((r) => r.label)).toEqual(['Serial', 'Make/Model', 'RU']);
    expect(rows.find((r) => r.label === 'RU')!.value).toBe('12');
  });

  it('omits the Position row when the note is null, undefined, or blank/whitespace', () => {
    expect(tooltipRows({ ...base, position: null }).some((r) => r.label === 'Position')).toBe(false);
    expect(tooltipRows({ ...base, position: undefined }).some((r) => r.label === 'Position')).toBe(false);
    expect(tooltipRows({ ...base, position: '' }).some((r) => r.label === 'Position')).toBe(false);
    expect(tooltipRows({ ...base, position: '   ' }).some((r) => r.label === 'Position')).toBe(false);
  });

  it('omits the Position row when the note is "front", case-insensitively', () => {
    expect(tooltipRows({ ...base, position: 'front' }).some((r) => r.label === 'Position')).toBe(false);
    expect(tooltipRows({ ...base, position: 'Front' }).some((r) => r.label === 'Position')).toBe(false);
    expect(tooltipRows({ ...base, position: 'FRONT' }).some((r) => r.label === 'Position')).toBe(false);
  });

  it('includes the Position row with the raw note for anything else (rear, left, etc.)', () => {
    const rear = tooltipRows({ ...base, position: 'rear' }).find((r) => r.label === 'Position');
    expect(rear?.value).toBe('rear');
    const left = tooltipRows({ ...base, position: 'left' }).find((r) => r.label === 'Position');
    expect(left?.value).toBe('left');
  });

  it('falls back to an em dash for missing serial/make-model rather than a blank value', () => {
    const rows = tooltipRows({ serial: null, makeModel: '', ru: 1, position: null });
    expect(rows.find((r) => r.label === 'Serial')!.value).toBe('—');
    expect(rows.find((r) => r.label === 'Make/Model')!.value).toBe('—');
  });

  it('includes a Category row before Position when the model has a category label', () => {
    const rows = tooltipRows({ ...base, position: 'rear', categoryLabel: 'Server' });
    expect(rows.map((r) => r.label)).toEqual(['Serial', 'Make/Model', 'RU', 'Category', 'Position']);
    expect(rows.find((r) => r.label === 'Category')!.value).toBe('Server');
  });

  it('omits the Category row when there is no category label', () => {
    expect(tooltipRows({ ...base, position: null }).some((r) => r.label === 'Category')).toBe(false);
    expect(tooltipRows({ ...base, position: null, categoryLabel: null })
      .some((r) => r.label === 'Category')).toBe(false);
  });
});

describe('rackRuCount', () => {
  it('is 52 by default and expands to the highest occupied RU + 1 rounded up to even', () => {
    expect(DEFAULT_RU_COUNT).toBe(52);
    expect(rackRuCount([])).toBe(52);
    expect(rackRuCount([{ ru: 40, height: 2 }])).toBe(52);
    expect(rackRuCount([{ ru: 51, height: 1 }])).toBe(52);   // top 51 -> 52 fits
    expect(rackRuCount([{ ru: 52, height: 1 }])).toBe(54);   // top 52 -> 53 -> 54
    expect(rackRuCount([{ ru: 57, height: 2 }])).toBe(60);   // top 58 -> 59 -> 60
    expect(rackRuCount([{ ru: 59, height: 1 }])).toBe(60);   // top 59 -> 60 even
  });
});
