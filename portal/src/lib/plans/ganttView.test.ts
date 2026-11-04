// @vitest-environment jsdom
/** The Gantt view's layout math (ganttView.ts): which slice of the scale is
 *  drawn, how bars clip to it, which links are drawn and where their arrows
 *  point, the initiative window band's label, what the hover card says, and
 *  the zoom, splitter and layout settings kept in localStorage, and the
 *  Below layout's end pads. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toMs } from './floatingTime';
import { LINK_STUB, MILESTONE_HALF, makeScale, xOf, type Zoom } from './ganttGeometry';
import {
  ARROW_LEN, LAYOUT_KEY, MIN_CHART_H, MIN_CHART_PX, MIN_LEAD_PX, MIN_SHEET_H, MIN_SHEET_PX, SCROLL_PAD, SPLIT_BELOW_KEY,
  SPLIT_KEY, SPLITTER_PX, LABEL_GAP_PX, bandsIn, barBox, endPads, labelPlace,
  PILL_GAP, TIER_CHAR_PX, TIER_PAD, chartWindow, clip, hoverFacts, lineAt, linkEnd, linkRow, linkShape, linkStub,
  linksToDraw, pillAt, pillWidth, readLayout, readSplit, readSplitBelow, readZoom, scaleSpan, splitHeight, splitWidth,
  taskScrollLeft, windowLabel, windowPillX, windowSpan, writeLayout, writeSplit, writeSplitBelow, writeZoom,
} from './ganttView';
import { makeLink, makePlan, makeTask } from './planFixtures';

const DAY = 86_400_000;

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('chartWindow: the slice of the scale the chart draws', () => {
  it('covers the visible part and a lead of half the pane each side, clamped to the scale', () => {
    expect(chartWindow(0, 800, 10_000)).toEqual([0, 1600]);
    expect(chartWindow(1000, 800, 10_000)).toEqual([400, 2400]);
    expect(chartWindow(9200, 800, 10_000)).toEqual([8800, 10_000]);
  });

  it('stays the same while the scroll moves within one lead, so nothing redraws', () => {
    expect(chartWindow(1100, 800, 10_000)).toEqual(chartWindow(1000, 800, 10_000));
    expect(chartWindow(1199, 800, 10_000)).toEqual(chartWindow(1000, 800, 10_000));
    expect(chartWindow(1200, 800, 10_000)).not.toEqual(chartWindow(1000, 800, 10_000));
  });

  it('keeps a lead of at least MIN_LEAD_PX for a pane not yet measured', () => {
    expect(chartWindow(0, 0, 10_000)).toEqual([0, 2 * MIN_LEAD_PX]);
  });

  it('always holds the visible part with at least one lead to spare on each side', () => {
    const scaleW = 528_000;              // three years at the hours zoom
    for (const paneW of [0, 320, 777, 1400]) {
      const lead = Math.max(MIN_LEAD_PX, paneW / 2);
      for (let x = 0; x <= scaleW - paneW; x += 997) {
        const [from, to] = chartWindow(x, paneW, scaleW);
        expect(from).toBeLessThanOrEqual(Math.max(0, x - lead));
        expect(to).toBeGreaterThanOrEqual(Math.min(scaleW, x + paneW + lead));
        // never anything close to the whole scale
        expect(to - from).toBeLessThanOrEqual(paneW + 4 * lead);
      }
    }
  });
});

describe('clip: a span in window coordinates', () => {
  const win = [400, 2400] as const;

  it('keeps a span inside the window, shifted to the window’s left edge', () => {
    expect(clip(500, 50, win)).toEqual({ x: 100, width: 50, cutStart: false, cutEnd: false });
  });

  it('cuts a span at the window’s edges and says which ends were cut', () => {
    expect(clip(100, 500, win)).toEqual({ x: 0, width: 200, cutStart: true, cutEnd: false });
    expect(clip(2300, 500, win)).toEqual({ x: 1900, width: 100, cutStart: false, cutEnd: true });
    expect(clip(0, 528_000, win)).toEqual({ x: 0, width: 2000, cutStart: true, cutEnd: true });
  });

  it('drops a span outside the window and keeps a point inside it', () => {
    expect(clip(0, 50, win)).toBeNull();
    expect(clip(2500, 10, win)).toBeNull();
    expect(clip(500, 0, win)).toEqual({ x: 100, width: 0, cutStart: false, cutEnd: false });
    expect(clip(2400, 0, win)).toEqual({ x: 2000, width: 0, cutStart: false, cutEnd: false });
    expect(clip(Number.NaN, 10, win)).toBeNull();
  });

  it('places bands and lines the same way', () => {
    expect(bandsIn([{ x: 0, width: 96 }, { x: 336, width: 96 }, { x: 2350, width: 96 }], win)).toEqual([
      { x: 0, width: 32, cutStart: true, cutEnd: false },
      { x: 1950, width: 50, cutStart: false, cutEnd: true },
    ]);
    expect(lineAt(1000, win)).toBe(600);
    expect(lineAt(399, win)).toBeNull();
    expect(lineAt(Number.NaN, win)).toBeNull();
  });
});

describe('barBox: a bar’s place in its row', () => {
  it('centers the bar in the row', () => {
    expect(barBox(30, false)).toEqual({ top: 9, height: 12, mid: 15, summaryHeight: 6, baseTop: 23, baseHeight: 4 });
  });

  it('lifts the bar to make room for the baseline under it', () => {
    expect(barBox(30, true)).toEqual({ top: 6, height: 12, mid: 12, summaryHeight: 6, baseTop: 20, baseHeight: 4 });
    const small = barBox(24, true);
    expect(small.baseTop + small.baseHeight).toBeLessThanOrEqual(24);
    expect(small.top).toBeGreaterThanOrEqual(0);
  });
});

describe('the initiative window band', () => {
  it('reads "Scheduled: Nov 14–16" with an en dash', () => {
    expect(windowLabel({ start: '2026-11-14', end: '2026-11-16' })).toBe('Scheduled: Nov 14–16');
  });

  it('names both months, and both years, when they differ', () => {
    expect(windowLabel({ start: '2026-11-30', end: '2026-12-02' })).toBe('Scheduled: Nov 30 – Dec 2');
    expect(windowLabel({ start: '2026-12-30', end: '2027-01-02' })).toBe('Scheduled: Dec 30, 2026 – Jan 2, 2027');
  });

  it('reads date-only fields that arrive as midnight UTC by their digits', () => {
    expect(windowLabel({ start: '2026-11-14T00:00:00Z', end: '2026-11-16T00:00:00+00:00' }))
      .toBe('Scheduled: Nov 14–16');
  });

  it('handles one day, one end, or none', () => {
    expect(windowLabel({ start: '2026-11-14', end: '2026-11-14' })).toBe('Scheduled: Nov 14');
    expect(windowLabel({ start: '2026-11-14', end: null })).toBe('Scheduled: from Nov 14');
    expect(windowLabel({ start: null, end: '2026-11-16' })).toBe('Scheduled: until Nov 16');
    expect(windowLabel({ start: null, end: null })).toBeNull();
    expect(windowLabel({ start: 'soon', end: 'later' })).toBeNull();
    expect(windowLabel(null)).toBeNull();
  });

  it('spans whole days, the last one included', () => {
    expect(windowSpan({ start: '2026-11-14', end: '2026-11-16' }))
      .toEqual([Date.UTC(2026, 10, 14), Date.UTC(2026, 10, 17)]);
    expect(windowSpan({ start: '2026-11-16', end: '2026-11-14' }))
      .toEqual([Date.UTC(2026, 10, 14), Date.UTC(2026, 10, 17)]);
    expect(windowSpan({ start: '2026-11-14', end: null })).toEqual([Date.UTC(2026, 10, 14), Date.UTC(2026, 10, 15)]);
    expect(windowSpan({ start: null, end: null })).toBeNull();
  });

  it('widens the scale’s span to take the window in', () => {
    const later = windowSpan({ start: '2026-11-14', end: '2026-11-16' });
    expect(scaleSpan('2026-11-02T08:00', '2026-11-05T17:00', later))
      .toEqual({ start: '2026-11-02T08:00', finish: '2026-11-17T00:00' });
    const earlier = windowSpan({ start: '2026-10-20', end: '2026-10-20' });
    expect(scaleSpan('2026-11-02T08:00', '2026-11-05T17:00', earlier))
      .toEqual({ start: '2026-10-20T00:00', finish: '2026-11-05T17:00' });
    expect(scaleSpan('2026-11-02T08:00', null, null)).toEqual({ start: '2026-11-02T08:00', finish: null });
    expect(scaleSpan('2026-11-02T08:00', null, later)).toEqual({ start: '2026-11-02T08:00', finish: '2026-11-17T00:00' });
  });
});

describe('links', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f'];
  const index = new Map(rows.map((id, i) => [id, i]));

  it('draws a link when both its tasks are shown and one end is within the rendered rows and the overscan', () => {
    const links = [
      makeLink('ab', 'a', 'b'), makeLink('bf', 'b', 'f'), makeLink('cd', 'c', 'd'), makeLink('xz', 'x', 'a'),
    ];
    // rendered rows 2..3 (c, d), one row of overscan: rows 1..4; bf's far end (f) runs off the edge
    expect(linksToDraw(links, index, 2, 3, 1).map((l) => l.id)).toEqual(['ab', 'bf', 'cd']);
    // only row 5 near: bf alone
    expect(linksToDraw(links, index, 5, 5, 0).map((l) => l.id)).toEqual(['bf']);
    // neither end near: not drawn
    expect(linksToDraw([makeLink('ab', 'a', 'b')], index, 4, 5, 0)).toEqual([]);
    // a link to a task that isn't shown (collapsed under a summary) is never drawn
    expect(linksToDraw(links, index, 0, 5, 20).map((l) => l.id)).not.toContain('xz');
  });

  it('holds a far end one row past the drawn rows, so its line visibly leaves the edge', () => {
    expect(linkRow(10, 5, 20)).toBe(10);
    expect(linkRow(1400, 0, 58)).toBe(59);
    expect(linkRow(0, 30, 90)).toBe(29);
  });

  it('uses a shorter stub at the coarse zooms', () => {
    expect((['hours', 'days', 'weeks', 'months', 'quarters'] as Zoom[]).map(linkStub)).toEqual([8, 8, 6, 4, 4]);
  });

  it('ends a milestone link at the diamond’s edge', () => {
    expect(linkEnd({ x: 300, width: 0 }, true, 45)).toEqual({ x0: 300 - MILESTONE_HALF, x1: 300 + MILESTONE_HALF, y: 45 });
    expect(linkEnd({ x: 100, width: 80 }, false, 15)).toEqual({ x0: 100, x1: 180, y: 15 });
  });

  it('points an FS arrow right at the successor’s start, the line stopping under the head', () => {
    const shape = linkShape({ x0: 100, x1: 200, y: 15 }, { x0: 300, x1: 400, y: 45 }, 'FS', 30, { stub: 8, toHalf: 6 });
    expect(shape).toEqual({
      d: 'M 200 15 H 208 V 45 H 296', dir: 'right', tip: [300, 45], head: '300,45 295,41.5 295,48.5',
    });
  });

  it('points into a milestone at its diamond’s left tip', () => {
    const to = linkEnd({ x: 300, width: 0 }, true, 45);
    const shape = linkShape({ x0: 100, x1: 200, y: 15 }, to, 'FS', 30, { stub: 8, toHalf: MILESTONE_HALF });
    expect(shape?.dir).toBe('right');
    expect(shape?.tip).toEqual([300 - MILESTONE_HALF, 45]);
  });

  it('points down when the path ends with a drop (a back-to-back handoff), stopping at the bar’s top', () => {
    const shape = linkShape({ x0: 100, x1: 200, y: 15 }, { x0: 200, x1: 260, y: 45 }, 'FS', 30, { stub: 8, toHalf: 6 });
    expect(shape).toEqual({ d: 'M 200 15 V 35', dir: 'down', tip: [200, 39], head: '200,39 196.5,34 203.5,34' });
  });

  it('points up into a successor above', () => {
    const shape = linkShape({ x0: 100, x1: 200, y: 45 }, { x0: 200, x1: 260, y: 15 }, 'FS', 30, { stub: 8, toHalf: 6 });
    expect(shape?.dir).toBe('up');
    expect(shape?.tip).toEqual([200, 21]);
  });

  it('points left into a finish (FF), whatever runs come before', () => {
    const shape = linkShape({ x0: 100, x1: 200, y: 15 }, { x0: 100, x1: 150, y: 45 }, 'FF', 30, { stub: 8, toHalf: 6 });
    expect(shape?.dir).toBe('left');
    expect(shape?.tip).toEqual([150, 45]);
    expect(shape?.d.endsWith(`H ${150 + ARROW_LEN - 1}`)).toBe(true);
  });

  it('follows a detour’s last run', () => {
    // the successor starts before the predecessor ends: five runs, the last one rightward
    const shape = linkShape({ x0: 100, x1: 200, y: 15 }, { x0: 120, x1: 180, y: 45 }, 'FS', 30, { stub: 8, toHalf: 6 });
    expect(shape?.d.split(/[HV]/).length).toBe(6);
    expect(shape?.dir).toBe('right');
    expect(shape?.tip).toEqual([120, 45]);
  });

  it('draws nothing for an end that is not a number', () => {
    expect(linkShape({ x0: Number.NaN, x1: 1, y: 1 }, { x0: 2, x1: 3, y: 4 }, 'FS', 30, { stub: 8, toHalf: 6 })).toBeNull();
  });
});

describe('the window label in the timescale’s top tier', () => {
  // a week at the days zoom: 336px, its label at its left
  const ticks = [{ x: 0, width: 336, label: "Nov 2, '26" }, { x: 336, width: 336, label: "Nov 9, '26" }];
  const labelEnd = (t: { x: number; label: string }) => t.x + TIER_PAD + t.label.length * TIER_CHAR_PX + PILL_GAP;

  it('is as wide as its text in the tier’s monospace type, plus its padding', () => {
    expect(pillWidth('Scheduled: Nov 4–5')).toBeCloseTo(18 * TIER_CHAR_PX + 18);
  });

  it('sits at the band’s left edge when that is clear of the tier’s labels', () => {
    expect(windowPillX(150, 'Scheduled: Nov 4–5', ticks)).toBe(150);
  });

  it('moves past the label of the unit it starts in', () => {
    expect(windowPillX(340, 'Scheduled: Nov 9–10', ticks)).toBeCloseTo(labelEnd(ticks[1]));
    expect(windowPillX(10, 'Scheduled: Nov 2', ticks)).toBeCloseTo(labelEnd(ticks[0]));
  });

  it('ends just before the next unit’s label when that is nearer than going past it', () => {
    // a band starting 36px before the next week: its label can't start there
    expect(windowPillX(300, 'Scheduled: Nov 8–9', ticks)).toBeCloseTo(336 - PILL_GAP - pillWidth('Scheduled: Nov 8–9'));
    // too little room before the next label: past it
    const wide = 'Scheduled: Nov 8, 2026 – Jan 4, 2027';
    expect(windowPillX(300, wide, ticks)).toBeCloseTo(labelEnd(ticks[1]));
  });

  it('moves past the label held at the view’s left edge as the view scrolls', () => {
    const quarters = [{ x: 0, width: 460, label: 'Q3 2026' }, { x: 460, width: 460, label: 'Q4 2026' }];
    const labelW = 7 * TIER_CHAR_PX;
    // the view's edge at 60: Q3's label is held at 66, so a label at 100 moves past it
    expect(pillAt(100, 'Scheduled: Sep 7–25', quarters, 60)).toBeCloseTo(60 + TIER_PAD + labelW + PILL_GAP);
    // at the scale's start the held label is where it always is, clear of 100
    expect(pillAt(100, 'Scheduled: Sep 7–25', quarters, 0)).toBe(100);
    // near its unit's end the held label stops whole inside the unit (ending at 454); just past it
    // the label would meet Q4's at 466, so it goes on past that
    expect(pillAt(420, 'Scheduled: Sep 7–25', quarters, 440)).toBeCloseTo(460 + TIER_PAD + labelW + PILL_GAP);
    // past the view's edge's unit: nothing to move for
    expect(pillAt(700, 'Scheduled: Oct 7–9', quarters, 60)).toBe(700);
    // moved past the held label into the next unit's: on past that one too
    expect(pillAt(330, 'Scheduled: Sep 7–25', quarters, 300)).toBeCloseTo(460 + TIER_PAD + labelW + PILL_GAP);
  });

  it('never overlaps a tick’s label', () => {
    for (let x = 0; x < 600; x += 7) {
      for (const text of ['Scheduled: Nov 4–5', 'Scheduled: Nov 30 – Dec 2']) {
        const at = windowPillX(x, text, ticks);
        for (const t of ticks) {
          const clear = at >= labelEnd(t) || at + pillWidth(text) + PILL_GAP <= t.x;
          expect(clear).toBe(true);
        }
      }
    }
  });
});

describe('taskScrollLeft (Scroll to Task)', () => {
  const scale = makeScale('2026-11-02T08:00', '2026-11-20T17:00', 'days');

  it('brings the bar’s start in, a little from the left edge', () => {
    const task = makeTask('a', { start: '2026-11-09T08:00', finish: '2026-11-10T17:00' });
    expect(taskScrollLeft(scale, task)).toBe(xOf(scale, '2026-11-09T08:00') - SCROLL_PAD);
  });

  it('leaves room for a milestone’s diamond, never scrolls left of the scale, and skips a task with no dates', () => {
    const milestone = makeTask('m', { is_milestone: true, start: '2026-11-09T17:00', finish: '2026-11-09T17:00' });
    expect(taskScrollLeft(scale, milestone)).toBe(xOf(scale, '2026-11-09T17:00') - MILESTONE_HALF - SCROLL_PAD);
    expect(taskScrollLeft(scale, makeTask('f', { start: '2026-10-31T08:00' }))).toBe(0);
    expect(taskScrollLeft(scale, makeTask('n', { start: null, finish: null }))).toBeNull();
  });
});

describe('hoverFacts', () => {
  it('says start, finish, duration in the plan’s units, %, assignees, deadline and slack', () => {
    const plan = makePlan();
    plan.calendar = { ...plan.calendar, hours_per_day: 10, hours_per_week: 50 };
    const task = makeTask('a', {
      duration_minutes: 600, duration_unit: 'd', percent_complete: 45, deadline: '2026-11-06T17:00',
      total_slack_minutes: 1200, assignees: [
        { kind: 'person', id: 'p1', name: 'Dana Reyes' }, { kind: 'partner', id: 'x', name: 'Champagne Logistics' }],
    });
    expect(hoverFacts(task, plan)).toEqual([
      { label: 'Start', value: 'Mon 11/2/26' },
      { label: 'Finish', value: 'Mon 11/2/26' },
      { label: 'Duration', value: '1 day' },
      { label: '% Complete', value: '45%' },
      { label: 'Resource Names', value: 'Dana Reyes, Champagne Logistics' },
      { label: 'Deadline', value: 'Fri 11/6/26' },
      { label: 'Total Slack', value: '2 days' },
    ]);
  });

  it('shows times when the plan does, and leaves out what the task lacks', () => {
    const plan = makePlan();
    plan.settings = { ...plan.settings, show_times: true };
    const facts = hoverFacts(makeTask('a', { total_slack_minutes: null }), plan);
    expect(facts.map((f) => f.label)).toEqual(['Start', 'Finish', 'Duration', '% Complete']);
    expect(facts[0].value).toBe('Mon 11/2/26 8:00 AM');
  });
});

describe('stored settings', () => {
  it('keeps the zoom per plan, days by default', () => {
    expect(readZoom('plan-1')).toBe('days');
    writeZoom('plan-1', 'weeks');
    expect(localStorage.getItem('plans.zoom.plan-1')).toBe('weeks');
    expect(readZoom('plan-1')).toBe('weeks');
    expect(readZoom('plan-2')).toBe('days');
    expect(readZoom(null)).toBe('days');
    localStorage.setItem('plans.zoom.plan-3', 'decades');
    expect(readZoom('plan-3')).toBe('days');
  });

  it('survives storage that refuses', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readZoom('plan-1')).toBe('days');
    expect(() => writeZoom('plan-1', 'hours')).not.toThrow();
    expect(readSplit()).toBeNull();
    expect(() => writeSplit(500)).not.toThrow();
    expect(readLayout()).toBe('beside');
    expect(() => writeLayout('below')).not.toThrow();
    expect(readSplitBelow()).toBeNull();
    expect(() => writeSplitBelow(300)).not.toThrow();
  });

  it('keeps the splitter’s place in px', () => {
    expect(readSplit()).toBeNull();
    writeSplit(520.4);
    expect(localStorage.getItem(SPLIT_KEY)).toBe('520');
    expect(readSplit()).toBe(520);
    localStorage.setItem(SPLIT_KEY, 'wide');
    expect(readSplit()).toBeNull();
    localStorage.setItem(SPLIT_KEY, '-4');
    expect(readSplit()).toBeNull();
  });

  it('opens the sheet at 45% of the view, and keeps room for both panes', () => {
    expect(splitWidth(null, 1000)).toBe(450);
    expect(splitWidth(600, 1000)).toBe(600);
    expect(splitWidth(40, 1000)).toBe(MIN_SHEET_PX);
    expect(splitWidth(990, 1000)).toBe(1000 - SPLITTER_PX - MIN_CHART_PX);
    expect(splitWidth(300, 250)).toBe(MIN_SHEET_PX);
    // nothing measured yet (no layout): the stored width, or a sensible one
    expect(splitWidth(700, 0)).toBe(700);
    expect(splitWidth(null, 0)).toBeGreaterThanOrEqual(MIN_SHEET_PX);
  });

  it('keeps the Gantt layout for the browser (the monitor, not the plan), Beside by default', () => {
    expect(LAYOUT_KEY).toBe('plans.layout.v1');
    expect(readLayout()).toBe('beside');
    writeLayout('below');
    expect(localStorage.getItem(LAYOUT_KEY)).toBe('below');
    expect(readLayout()).toBe('below');
    writeLayout('hidden');
    expect(readLayout()).toBe('hidden');
    for (const bad of ['sideways', '', 'BELOW', '{"layout":"below"}']) {
      localStorage.setItem(LAYOUT_KEY, bad);
      expect(readLayout(), bad).toBe('beside');
    }
  });

  it('keeps Below’s split (the sheet’s height) apart from Beside’s width', () => {
    expect(SPLIT_BELOW_KEY).toBe('plans.split.below.v1');
    expect(readSplitBelow()).toBeNull();
    writeSplitBelow(287.6);
    expect(localStorage.getItem(SPLIT_BELOW_KEY)).toBe('288');
    expect(readSplitBelow()).toBe(288);
    expect(readSplit()).toBeNull();                      // Beside's width is its own
    localStorage.setItem(SPLIT_BELOW_KEY, 'tall');
    expect(readSplitBelow()).toBeNull();
    localStorage.setItem(SPLIT_BELOW_KEY, '0');
    expect(readSplitBelow()).toBeNull();
  });

  it('opens Below with the sheet half the view tall, and keeps room for both panes', () => {
    expect(splitHeight(null, 600)).toBe(297);              // (600 - 6) / 2
    expect(splitHeight(400, 600)).toBe(400);
    expect(splitHeight(40, 600)).toBe(MIN_SHEET_H);
    expect(splitHeight(590, 600)).toBe(600 - SPLITTER_PX - MIN_CHART_H);
    expect(splitHeight(300, 200)).toBe(MIN_SHEET_H);        // too short for both: the sheet keeps its least
    // nothing measured yet: the stored height, or a sensible one
    expect(splitHeight(350, 0)).toBe(350);
    expect(splitHeight(null, 0)).toBeGreaterThanOrEqual(MIN_SHEET_H);
  });
});

describe('the Below layout', () => {
  it('pads the taller pane so both scroll the same distance (rows stay lined up to the last)', () => {
    // a 300px sheet over a 400px chart: the chart's 100px more view needs 100px more to scroll
    expect(endPads(300, 400)).toEqual({ sheet: 0, chart: 100 });
    expect(endPads(420, 300)).toEqual({ sheet: 120, chart: 0 });
    expect(endPads(300, 300)).toEqual({ sheet: 0, chart: 0 });
    // not measured yet: no pads
    expect(endPads(0, 400)).toEqual({ sheet: 0, chart: 0 });
  });

  it('puts a task’s name left of its bar, ellipsized to the room there, else after the bar', () => {
    // plenty of room before the bar: up to it, at most the label width
    expect(labelPlace(600)).toEqual({ side: 'before', width: 200 });
    // some room: the room there, less the gap that keeps a link's stub and arrowhead clear
    expect(LABEL_GAP_PX).toBeGreaterThan(LINK_STUB + 1);
    expect(LINK_STUB).toBeGreaterThan(ARROW_LEN);
    expect(labelPlace(120)).toEqual({ side: 'before', width: 120 - LABEL_GAP_PX });
    // too little to read: after the bar
    expect(labelPlace(40)).toEqual({ side: 'after', width: 200 });
    expect(labelPlace(0)).toEqual({ side: 'after', width: 200 });
  });
});

it('toMs agrees with the window span for a date alone (no zone shift)', () => {
  expect(windowSpan({ start: '2026-03-08', end: '2026-03-08' })).toEqual([toMs('2026-03-08'), toMs('2026-03-08') + DAY]);
});
