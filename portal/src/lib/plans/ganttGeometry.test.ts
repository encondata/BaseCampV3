/** Gantt geometry: plan times to pixels, tiers, bars and link paths. Pure
 *  functions over floating plan times (UTC-naive, see floatingTime.ts), so a
 *  tick label never depends on the browser's zone (Review Focus 4). */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fromMs, toMs } from './floatingTime';
import {
  baselineOf, barOf, FIT_MARGIN, fitScrollLeft, fitZoom, LINK_STUB, linkPath, makeScale,
  MILESTONE_HALF, msOf, progressWidth, tiers, xOf, ZOOM_PX_PER_DAY, ZOOMS, zoomIn, zoomOut,
  type Scale, type Zoom,
} from './ganttGeometry';
import { makeTask } from './planFixtures';

const DAY = 86_400_000;

/** A scale written out by hand, so a tier test does not lean on makeScale's padding. */
function scaleOf(from: string, to: string, zoom: Zoom): Scale {
  const startMs = toMs(from);
  const endMs = toMs(to);
  return {
    startMs, endMs, pxPerMs: ZOOM_PX_PER_DAY[zoom] / DAY,
    width: ((endMs - startMs) * ZOOM_PX_PER_DAY[zoom]) / DAY,
  };
}

const labels = (ticks: { label: string }[]): string[] => ticks.map((t) => t.label);

describe('zoom levels', () => {
  it('keeps the px per day the spec gives', () => {
    expect(ZOOM_PX_PER_DAY).toEqual({ hours: 480, days: 48, weeks: 18, months: 5, quarters: 1.8 });
    expect(ZOOMS).toEqual(['hours', 'days', 'weeks', 'months', 'quarters']);
  });

  it('zooms in toward hours and out toward quarters, and stops at the ends', () => {
    expect(zoomIn('quarters')).toBe('months');
    expect(zoomIn('months')).toBe('weeks');
    expect(zoomIn('weeks')).toBe('days');
    expect(zoomIn('days')).toBe('hours');
    expect(zoomIn('hours')).toBe('hours');
    expect(zoomOut('hours')).toBe('days');
    expect(zoomOut('days')).toBe('weeks');
    expect(zoomOut('weeks')).toBe('months');
    expect(zoomOut('months')).toBe('quarters');
    expect(zoomOut('quarters')).toBe('quarters');
  });
});

describe('makeScale', () => {
  it('pads two days before and four after at days zoom, snapped to the day', () => {
    const scale = makeScale('2026-11-02T08:00', '2026-11-06T17:00', 'days');
    expect(scale.startMs).toBe(toMs('2026-10-31T00:00'));
    // 11-06 17:00 is in the 11-06 day; the padding counts from that day's end
    expect(scale.endMs).toBe(toMs('2026-11-11T00:00'));
    expect(scale.width).toBe(11 * 48);
    expect(scale.pxPerMs * DAY).toBe(48);
  });

  it('counts four days from a finish that sits on a day boundary', () => {
    const scale = makeScale('2026-11-02', '2026-11-06', 'days');
    expect(scale.endMs).toBe(toMs('2026-11-10T00:00'));
  });

  it('snaps to the bottom tier’s unit at every zoom', () => {
    // hours
    const hours = makeScale('2026-11-02T08:30', '2026-11-02T17:00', 'hours');
    expect(fromMs(hours.startMs)).toBe('2026-11-02T06:00');
    expect(fromMs(hours.endMs)).toBe('2026-11-02T21:00');
    // weeks begin on Monday: Wed 11-04 sits in the week of Mon 11-02
    const weeks = makeScale('2026-11-04T08:00', '2026-12-04T17:00', 'weeks');
    expect(fromMs(weeks.startMs)).toBe('2026-10-19T00:00');
    expect(fromMs(weeks.endMs)).toBe('2027-01-04T00:00');
    // months
    const months = makeScale('2026-11-15', '2027-01-20', 'months');
    expect(fromMs(months.startMs)).toBe('2026-09-01T00:00');
    expect(fromMs(months.endMs)).toBe('2027-06-01T00:00');
    // quarters
    const quarters = makeScale('2026-11-15', '2027-02-10', 'quarters');
    expect(fromMs(quarters.startMs)).toBe('2026-04-01T00:00');
    expect(fromMs(quarters.endMs)).toBe('2028-04-01T00:00');
  });

  it('measures the width in px at the zoom’s rate', () => {
    for (const zoom of ZOOMS) {
      const scale = makeScale('2026-11-02T08:00', '2026-11-20T17:00', zoom);
      expect(scale.width).toBeCloseTo(((scale.endMs - scale.startMs) / DAY) * ZOOM_PX_PER_DAY[zoom], 6);
      expect(xOf(scale, fromMs(scale.endMs))).toBeCloseTo(scale.width, 6);
    }
  });

  it('draws an empty plan (no finish) as a single day of padding', () => {
    const scale = makeScale('2026-11-02T08:00', null, 'days');
    expect(scale.startMs).toBe(toMs('2026-10-31T00:00'));
    expect(scale.endMs).toBe(toMs('2026-11-07T00:00'));
  });

  it('treats a finish before the start as the start', () => {
    const scale = makeScale('2026-11-02T08:00', '2026-10-01T08:00', 'days');
    expect(scale.endMs).toBe(toMs('2026-11-07T00:00'));
  });

  it('refuses a start that is not a plan time', () => {
    expect(() => makeScale('soon', '2026-11-06', 'days')).toThrow(RangeError);
  });
});

describe('xOf / msOf', () => {
  const scale = makeScale('2026-11-02T08:00', '2026-11-06T17:00', 'days');

  it('puts a plan time on the pixel axis', () => {
    expect(xOf(scale, '2026-10-31T00:00')).toBe(0);
    expect(xOf(scale, '2026-11-02T00:00')).toBe(96);
    expect(xOf(scale, '2026-11-02T08:00')).toBe(112);
    expect(xOf(scale, '2026-11-02')).toBe(96);
  });

  it('moves one day’s px at every zoom', () => {
    for (const zoom of ZOOMS) {
      const s = makeScale('2026-11-02T08:00', '2026-11-20T17:00', zoom);
      expect(xOf(s, fromMs(s.startMs + DAY))).toBe(ZOOM_PX_PER_DAY[zoom]);
    }
  });

  it('is NaN for text that is not a plan time', () => {
    expect(Number.isNaN(xOf(scale, 'soon'))).toBe(true);
  });

  it('msOf inverts xOf at every zoom (the drag path)', () => {
    for (const zoom of ZOOMS) {
      const s = makeScale('2026-11-02T08:00', '2026-12-18T17:00', zoom);
      for (const text of ['2026-11-02T08:00', '2026-11-06T17:00', '2026-12-01T00:00', '2026-11-30T13:37']) {
        const ms = msOf(s, xOf(s, text));
        expect(Math.abs(ms - toMs(text))).toBeLessThan(1);
        expect(fromMs(Math.round(ms))).toBe(text);
      }
    }
  });

  it('msOf reads a pixel as a time, left of the scale too', () => {
    expect(msOf(scale, 0)).toBe(scale.startMs);
    expect(msOf(scale, 112)).toBe(toMs('2026-11-02T08:00'));
    expect(msOf(scale, -48)).toBe(toMs('2026-10-30T00:00'));
  });
});

describe('bars', () => {
  const scale = makeScale('2026-11-02T08:00', '2026-11-06T17:00', 'days');

  it('spans start to finish', () => {
    const bar = barOf(scale, makeTask('a', { start: '2026-11-02T08:00', finish: '2026-11-06T17:00' }));
    expect(bar).toEqual({ x: 112, width: ((4 * 24 + 9) / 24) * 48 });
    expect(bar?.width).toBe(210);
  });

  it('gives a milestone no width', () => {
    const bar = barOf(scale, makeTask('m', {
      is_milestone: true, start: '2026-11-04T17:00', finish: '2026-11-04T17:00',
    }));
    expect(bar).toEqual({ x: xOf(scale, '2026-11-04T17:00'), width: 0 });
  });

  it('has no bar for a task without dates, and never a negative width', () => {
    expect(barOf(scale, makeTask('n', { start: null, finish: null }))).toBeNull();
    expect(barOf(scale, makeTask('n', { start: '2026-11-02T08:00', finish: null }))).toBeNull();
    expect(barOf(scale, makeTask('m', { is_milestone: true, start: null, finish: null }))).toBeNull();
    const backwards = barOf(scale, makeTask('b', { start: '2026-11-04T08:00', finish: '2026-11-03T08:00' }));
    expect(backwards?.width).toBe(0);
  });

  it('fills a share of the bar for % complete', () => {
    const bar = { x: 112, width: 210 };
    expect(progressWidth(bar, 0)).toBe(0);
    expect(progressWidth(bar, 50)).toBe(105);
    expect(progressWidth(bar, 100)).toBe(210);
    expect(progressWidth(bar, 140)).toBe(210);
    expect(progressWidth(bar, -5)).toBe(0);
    expect(progressWidth(bar, Number.NaN)).toBe(0);
  });

  it('places the baseline from the baseline dates, or not at all', () => {
    const none = makeTask('a');
    expect(baselineOf(scale, none)).toBeNull();
    expect(baselineOf(scale, makeTask('a', { baseline_start: '2026-11-02T08:00', baseline_finish: null }))).toBeNull();
    const based = makeTask('a', { baseline_start: '2026-11-02T08:00', baseline_finish: '2026-11-04T17:00' });
    expect(baselineOf(scale, based)).toEqual({ x: 112, width: ((2 * 24 + 9) / 24) * 48 });
    const milestone = makeTask('m', { baseline_start: '2026-11-04T17:00', baseline_finish: '2026-11-04T17:00' });
    expect(baselineOf(scale, milestone)?.width).toBe(0);
  });
});

describe('fitZoom', () => {
  const start = '2026-11-02';
  const after = (days: number): string => fromMs(toMs(start) + days * DAY);
  /** The plan's own span in px at a zoom, without the scale's padding. */
  const rawPx = (days: number, zoom: Zoom): number => days * ZOOM_PX_PER_DAY[zoom];

  it('keeps a margin of two link stubs and a milestone half-width', () => {
    expect(LINK_STUB).toBe(8);
    expect(MILESTONE_HALF).toBe(6);
    expect(FIT_MARGIN).toBe(2 * LINK_STUB + MILESTONE_HALF);
    expect(FIT_MARGIN).toBe(22);
  });

  it('keeps the brief’s two cases', () => {
    expect(fitZoom(start, after(14), 1000)).toBe('days');                       // a 2-week plan
    expect(fitZoom(start, '2029-11-02', 1000)).toBe('quarters');               // a 3-year plan
    expect(fitZoom('2026-11-02T08:00', '2026-11-13T17:00', 1000)).toBe('days');
    // twelve hours of work come to 240px at 480 px/day
    expect(fitZoom('2026-11-02T08:00', '2026-11-02T20:00', 1000)).toBe('hours');
  });

  it.each([
    [1, 'hours'], [2, 'hours'], [3, 'days'], [10, 'days'], [14, 'days'], [20, 'days'],
    [21, 'weeks'], [42, 'weeks'], [54, 'weeks'], [55, 'months'], [90, 'months'], [180, 'months'],
    [195, 'months'], [196, 'quarters'], [365, 'quarters'],
  ] as [number, Zoom][])('fits %i days in 1,000px at %s, the padding not counted', (days, zoom) => {
    expect(fitZoom(start, after(days), 1000)).toBe(zoom);
  });

  it('takes a width equal to the room left after the margin', () => {
    // 20 days 9 hours is 978px at 48 px/day: exactly 1000 - FIT_MARGIN
    expect(fitZoom(start, fromMs(toMs(start) + 20 * DAY + 9 * 3_600_000), 1000)).toBe('days');
    expect(fitZoom(start, fromMs(toMs(start) + 20 * DAY + 10 * 3_600_000), 1000)).toBe('weeks');
  });

  it('picks the finest zoom whose raw span fits, for every span', () => {
    for (let days = 1; days <= 800; days += 1) {
      const pick = fitZoom(start, after(days), 1000);
      if (pick !== 'quarters') expect(rawPx(days, pick)).toBeLessThanOrEqual(1000 - FIT_MARGIN);
      for (const finer of ZOOMS.slice(0, ZOOMS.indexOf(pick))) {
        expect(rawPx(days, finer)).toBeGreaterThan(1000 - FIT_MARGIN);
      }
    }
  });

  it('shows an empty span at days zoom, whatever the width', () => {
    expect(fitZoom(start, start, 1000)).toBe('days');
    expect(fitZoom(start, null, 1000)).toBe('days');
    expect(fitZoom(start, after(-3), 1000)).toBe('days');
    expect(fitZoom(start, start, 0)).toBe('days');
  });

  it('falls back to quarters when the room is gone', () => {
    expect(fitZoom(start, after(11), 0)).toBe('quarters');
    expect(fitZoom(start, after(11), FIT_MARGIN)).toBe('quarters');
    expect(fitZoom(start, after(11), Number.NaN)).toBe('quarters');
  });

  it('refuses a start that is not a plan time', () => {
    expect(() => fitZoom('soon', after(3), 1000)).toThrow(RangeError);
  });
});

describe('fitScrollLeft', () => {
  it('scrolls to the project start, half the margin short of it', () => {
    const scale = makeScale('2026-11-02T08:00', '2026-11-06T17:00', 'days');
    expect(xOf(scale, '2026-11-02T08:00')).toBe(112);
    expect(fitScrollLeft(scale, '2026-11-02T08:00')).toBe(112 - FIT_MARGIN / 2);
  });

  it('never scrolls left of the scale', () => {
    const scale = makeScale('2026-11-02T08:00', '2026-11-06T17:00', 'days');
    expect(fitScrollLeft({ ...scale, startMs: toMs('2026-11-02T08:00') }, '2026-11-02T08:00')).toBe(0);
    expect(fitScrollLeft(scale, '2026-10-01')).toBe(0);
    expect(fitScrollLeft(scale, 'soon')).toBe(0);
  });
});

describe('tiers', () => {
  const tile = (ticks: { x: number; width: number }[], width: number): void => {
    expect(ticks[0].x).toBe(0);
    ticks.slice(1).forEach((t, i) => expect(t.x).toBeCloseTo(ticks[i].x + ticks[i].width, 6));
    const last = ticks[ticks.length - 1];
    expect(last.x + last.width).toBeCloseTo(width, 6);
  };

  it('labels weeks over days at days zoom', () => {
    const scale = makeScale('2026-11-02T08:00', '2026-11-06T17:00', 'days');
    const { top, bottom } = tiers(scale, 'days');
    expect(labels(top)).toEqual(["Oct 26, '26", "Nov 2, '26", "Nov 9, '26"]);
    // Sat 10-31 .. Tue 11-10, one letter each
    expect(labels(bottom).join('')).toBe('SSMTWTFSSMT');
    expect(top.map((t) => [t.x, t.width])).toEqual([[0, 96], [96, 336], [432, 96]]);
    expect(bottom.every((t) => t.width === 48)).toBe(true);
    tile(top, scale.width);
    tile(bottom, scale.width);
  });

  it('labels months over weeks at weeks zoom', () => {
    // a week-aligned scale that begins on the Monday of 11/2
    const begin = tiers(scaleOf('2026-11-02', '2026-11-30', 'weeks'), 'weeks');
    expect(begin.top[0].label).toBe('November 2026');
    expect(begin.bottom[0].label).toBe('11/2');
    expect(labels(begin.bottom)).toEqual(['11/2', '11/9', '11/16', '11/23']);

    const scale = makeScale('2026-11-02T08:00', '2026-12-04T17:00', 'weeks');
    const { top, bottom } = tiers(scale, 'weeks');
    expect(labels(top)).toEqual(['October 2026', 'November 2026', 'December 2026', 'January 2027']);
    expect(labels(bottom)[0]).toBe('10/19');
    const at = bottom.find((t) => t.label === '11/2');
    expect(at).toEqual({ x: 14 * 18, width: 7 * 18, label: '11/2' });
    tile(top, scale.width);
    tile(bottom, scale.width);
  });

  it('labels days over hours at hours zoom', () => {
    const scale = makeScale('2026-11-02T20:00', '2026-11-03T01:00', 'hours');
    const { top, bottom } = tiers(scale, 'hours');
    expect(labels(top)).toEqual(['Mon 11/2', 'Tue 11/3']);
    expect(top.map((t) => t.width)).toEqual([6 * 20, 5 * 20]);
    expect(labels(bottom)).toEqual(['18', '19', '20', '21', '22', '23', '0', '1', '2', '3', '4']);
    expect(bottom.every((t) => t.width === 20)).toBe(true);
    tile(top, scale.width);
    tile(bottom, scale.width);
  });

  it('labels quarters over months at months zoom', () => {
    const scale = makeScale('2026-11-15', '2027-01-20', 'months');
    const { top, bottom } = tiers(scale, 'months');
    expect(labels(top)).toEqual(['Q3 2026', 'Q4 2026', 'Q1 2027', 'Q2 2027']);
    expect(labels(bottom)).toEqual(['Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May']);
    expect(top.map((t) => t.width)).toEqual([30 * 5, 92 * 5, 90 * 5, 61 * 5]);
    tile(top, scale.width);
    tile(bottom, scale.width);
  });

  it('labels years over quarters at quarters zoom', () => {
    const scale = makeScale('2026-11-15', '2027-02-10', 'quarters');
    const { top, bottom } = tiers(scale, 'quarters');
    expect(labels(top)).toEqual(['2026', '2027', '2028']);
    expect(labels(bottom)).toEqual(['Q2', 'Q3', 'Q4', 'Q1', 'Q2', 'Q3', 'Q4', 'Q1']);
    expect(top[1].width).toBeCloseTo(365 * 1.8, 6);
    tile(top, scale.width);
    tile(bottom, scale.width);
  });

  it('gives February 29 days in a leap year and 28 in the year before', () => {
    const leap = tiers(makeScale('2028-01-10', '2028-03-20', 'months'), 'months');
    expect(labels(leap.bottom)).toEqual(['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul']);
    expect(leap.bottom[3].width).toBeCloseTo(29 * 5, 6);
    expect(leap.bottom[2].width).toBeCloseTo(31 * 5, 6);
    // Q4 2027 is cut at the scale's start: November and December only
    expect(labels(leap.top)).toEqual(['Q4 2027', 'Q1 2028', 'Q2 2028', 'Q3 2028']);
    expect(leap.top[0].width).toBeCloseTo(61 * 5, 6);
    expect(leap.top[1].width).toBeCloseTo(91 * 5, 6);
    const plain = tiers(makeScale('2027-01-10', '2027-03-20', 'months'), 'months');
    expect(plain.bottom[3].label).toBe('Feb');
    expect(plain.bottom[3].width).toBeCloseTo(28 * 5, 6);
    expect(plain.top[1].width).toBeCloseTo(90 * 5, 6);
  });

  it('starts every weekly tick on a Monday', () => {
    const scale = makeScale('2026-11-04T08:00', '2027-02-26T17:00', 'weeks');
    for (const t of tiers(scale, 'weeks').bottom) {
      expect(new Date(scale.startMs + t.x / scale.pxPerMs).getUTCDay()).toBe(1);
    }
  });
});

describe('tiers in a window', () => {
  // three years at 20 px an hour: over 26,000 hour ticks
  const scale = makeScale('2026-01-01', '2028-12-31', 'hours');
  const meets = (t: { x: number; width: number }, from: number, to: number): boolean =>
    t.x < to && t.x + t.width > from;

  it('is the whole tier without a window', () => {
    const all = tiers(scale, 'hours');
    expect(all.bottom.length).toBeGreaterThan(26_000);
    expect(tiers(scale, 'hours', undefined)).toEqual(all);
  });

  it('keeps only the ticks that meet a 1,500px window', () => {
    const all = tiers(scale, 'hours');
    const { top, bottom } = tiers(scale, 'hours', [20_000, 21_500]);
    expect(bottom.length).toBeLessThan(100);
    expect(bottom.length).toBeGreaterThanOrEqual(75);
    expect(top.length).toBeLessThan(6);
    expect(bottom).toEqual(all.bottom.filter((t) => meets(t, 20_000, 21_500)));
    expect(top).toEqual(all.top.filter((t) => meets(t, 20_000, 21_500)));
    // the ticks at the window's edges are whole, not cut to it
    expect(bottom[0].x).toBeLessThanOrEqual(20_000);
    expect(bottom[0].x + bottom[0].width).toBeGreaterThan(20_000);
    expect(bottom[bottom.length - 1].x).toBeLessThan(21_500);
  });

  it('does not take a tick that only touches the window', () => {
    const { bottom } = tiers(scale, 'hours', [20_000, 20_100]);     // 20,000 = a tick edge
    expect(bottom.map((t) => t.x)).toEqual([20_000, 20_020, 20_040, 20_060, 20_080]);
  });

  it('reaches a window at the scale’s start and past its end', () => {
    expect(tiers(scale, 'hours', [-500, 60]).bottom.map((t) => t.x)).toEqual([0, 20, 40]);
    const last = tiers(scale, 'hours').bottom.at(-1);
    expect(tiers(scale, 'hours', [scale.width - 30, scale.width + 900]).bottom.at(-1)).toEqual(last);
    expect(tiers(scale, 'hours', [scale.width + 10, scale.width + 900])).toEqual({ top: [], bottom: [] });
    expect(tiers(scale, 'hours', [-900, -10])).toEqual({ top: [], bottom: [] });
  });

  it('treats a side that is not a number as open, and a backwards window as empty', () => {
    const all = tiers(scale, 'hours');
    expect(tiers(scale, 'hours', [Number.NaN, Number.NaN])).toEqual(all);
    expect(tiers(scale, 'hours', [20_000, 20_000])).toEqual({ top: [], bottom: [] });
    expect(tiers(scale, 'hours', [21_500, 20_000])).toEqual({ top: [], bottom: [] });
  });

  it('windows every zoom the same as filtering the whole tier', () => {
    for (const zoom of ZOOMS) {
      const s = makeScale('2026-03-02', '2028-09-15', zoom);
      const from = s.width * 0.3;
      const to = from + 400;
      const whole = tiers(s, zoom);
      const part = tiers(s, zoom, [from, to]);
      expect(part.bottom).toEqual(whole.bottom.filter((t) => meets(t, from, to)));
      expect(part.top).toEqual(whole.top.filter((t) => meets(t, from, to)));
    }
  });
});

describe('linkPath', () => {
  const pred = { x0: 100, x1: 200, y: 20 };
  const rowH = 40;
  const runs = (path: string): number => (path.match(/[HV]/g) ?? []).length;

  it('runs a forward finish-to-start link out, down and in', () => {
    const path = linkPath(pred, { x0: 300, x1: 400, y: 60 }, 'FS', rowH);
    expect(path).toBe('M 200 20 H 208 V 60 H 300');
    expect(runs(path)).toBe(3);
  });

  it('detours below the predecessor row when the successor starts left of the predecessor’s end', () => {
    const path = linkPath(pred, { x0: 150, x1: 250, y: 60 }, 'FS', rowH);
    expect(path).toBe('M 200 20 H 208 V 40 H 142 V 60 H 150');
    expect(runs(path)).toBe(5);
    // one pixel behind the end is behind it
    expect(runs(linkPath(pred, { x0: 199, x1: 300, y: 60 }, 'FS', rowH))).toBe(5);
  });

  it('detours above when the successor is on a row above', () => {
    const path = linkPath({ x0: 100, x1: 200, y: 60 }, { x0: 150, x1: 250, y: 20 }, 'FS', rowH);
    expect(path).toBe('M 200 60 H 208 V 40 H 142 V 20 H 150');
  });

  describe('a successor that starts at or just past the predecessor’s end', () => {
    it('drops straight onto it for a zero-lag handoff, with no S-detour', () => {
      expect(linkPath(pred, { x0: 200, x1: 300, y: 60 }, 'FS', rowH)).toBe('M 200 20 V 60');
    });

    it('turns at the successor’s edge when it is within the stub', () => {
      expect(linkPath(pred, { x0: 204, x1: 300, y: 60 }, 'FS', rowH)).toBe('M 200 20 H 204 V 60');
      expect(linkPath(pred, { x0: 208, x1: 300, y: 60 }, 'FS', rowH)).toBe('M 200 20 H 208 V 60');
      expect(linkPath(pred, { x0: 209, x1: 300, y: 60 }, 'FS', rowH)).toBe('M 200 20 H 208 V 60 H 209');
    });

    it('reads at days zoom: zero lag, then a 2-hour gap (4px)', () => {
      const scale = makeScale('2026-11-02T08:00', '2026-11-06T17:00', 'days');
      const end = xOf(scale, '2026-11-04T17:00');
      const from = { x0: xOf(scale, '2026-11-04T08:00'), x1: end, y: 20 };
      expect(end).toBe(226);
      const zero = linkPath(from, { x0: xOf(scale, '2026-11-04T17:00'), x1: 300, y: 60 }, 'FS', rowH);
      expect(zero).toBe('M 226 20 V 60');
      const gap = linkPath(from, { x0: xOf(scale, '2026-11-04T19:00'), x1: 300, y: 60 }, 'FS', rowH);
      expect(gap).toBe('M 226 20 H 230 V 60');
      expect(runs(zero)).toBe(1);
      expect(runs(gap)).toBe(2);
    });
  });

  it('starts a start-to-start link at the predecessor’s start and ends at the successor’s start', () => {
    expect(linkPath(pred, { x0: 100, x1: 300, y: 60 }, 'SS', rowH)).toBe('M 100 20 H 92 V 60 H 100');
    expect(linkPath(pred, { x0: 96, x1: 300, y: 60 }, 'SS', rowH)).toBe('M 100 20 H 92 V 60 H 96');
    // a successor starting far left needs no detour: the drop moves out to its stub
    expect(linkPath(pred, { x0: 50, x1: 90, y: 60 }, 'SS', rowH)).toBe('M 100 20 H 42 V 60 H 50');
  });

  it('starts a finish-to-finish link at the predecessor’s end and ends at the successor’s end', () => {
    expect(linkPath(pred, { x0: 120, x1: 200, y: 60 }, 'FF', rowH)).toBe('M 200 20 H 208 V 60 H 200');
    expect(linkPath(pred, { x0: 120, x1: 205, y: 60 }, 'FF', rowH)).toBe('M 200 20 H 208 V 60 H 205');
    // a successor ending far right needs no detour either
    const far = linkPath({ x0: 100, x1: 200, y: 100 }, { x0: 400, x1: 500, y: 20 }, 'FF', rowH);
    expect(far).toBe('M 200 100 H 508 V 20 H 500');
    expect(runs(far)).toBe(3);
    expect(linkPath(pred, { x0: 250, x1: 300, y: 60 }, 'FF', rowH)).toBe('M 200 20 H 308 V 60 H 300');
  });

  it('starts a start-to-finish link at the predecessor’s start and ends at the successor’s end', () => {
    const from = { x0: 300, x1: 400, y: 20 };
    expect(linkPath(from, { x0: 20, x1: 100, y: 60 }, 'SF', rowH)).toBe('M 300 20 H 292 V 60 H 100');
    expect(linkPath(from, { x0: 220, x1: 295, y: 60 }, 'SF', rowH)).toBe('M 300 20 H 295 V 60');
    expect(linkPath(from, { x0: 220, x1: 300, y: 60 }, 'SF', rowH)).toBe('M 300 20 V 60');
    // a successor ending right of the predecessor’s start is behind the line: it detours
    const behind = linkPath(from, { x0: 320, x1: 350, y: 60 }, 'SF', rowH);
    expect(behind).toBe('M 300 20 H 292 V 40 H 358 V 60 H 350');
    expect(runs(behind)).toBe(5);
  });

  it('rounds to a hundredth of a pixel and takes a narrower stub', () => {
    expect(linkPath({ x0: 0, x1: 100.123456, y: 20 }, { x0: 300.5, x1: 400, y: 60 }, 'FS', rowH))
      .toBe('M 100.12 20 H 108.12 V 60 H 300.5');
    expect(linkPath(pred, { x0: 300, x1: 400, y: 60 }, 'FS', rowH, 3)).toBe('M 200 20 H 203 V 60 H 300');
    expect(LINK_STUB).toBe(8);
  });

  it('starts and ends a link at a milestone’s point (x0 === x1)', () => {
    const diamond = { x0: 200, x1: 200, y: 20 };
    expect(linkPath(diamond, { x0: 300, x1: 400, y: 60 }, 'FS', rowH)).toBe('M 200 20 H 208 V 60 H 300');
    expect(linkPath(pred, { x0: 300, x1: 300, y: 60 }, 'FS', rowH)).toBe('M 200 20 H 208 V 60 H 300');
    // milestone to milestone on the same instant
    expect(linkPath(diamond, { x0: 200, x1: 200, y: 60 }, 'FS', rowH)).toBe('M 200 20 V 60');
    expect(linkPath(diamond, { x0: 150, x1: 150, y: 60 }, 'FS', rowH)).toBe('M 200 20 H 208 V 40 H 142 V 60 H 150');
  });

  it('draws a link between bars on the same row without a zero-length turn', () => {
    expect(linkPath(pred, { x0: 300, x1: 400, y: 20 }, 'FS', rowH)).toBe('M 200 20 H 300');
    expect(linkPath(pred, { x0: 200, x1: 400, y: 20 }, 'FS', rowH)).toBe('M 200 20');
    // behind the end on the same row still goes around, below
    expect(linkPath(pred, { x0: 150, x1: 250, y: 20 }, 'FS', rowH)).toBe('M 200 20 H 208 V 40 H 142 V 20 H 150');
  });

  it('answers an empty path for a number that is not finite', () => {
    const to = { x0: 300, x1: 400, y: 60 };
    expect(linkPath({ ...pred, x1: Number.NaN }, to, 'FS', rowH)).toBe('');
    expect(linkPath({ ...pred, x0: Number.NaN }, to, 'SS', rowH)).toBe('');
    expect(linkPath({ ...pred, y: Number.POSITIVE_INFINITY }, to, 'FS', rowH)).toBe('');
    expect(linkPath(pred, { ...to, x0: Number.NaN }, 'FS', rowH)).toBe('');
    expect(linkPath(pred, { ...to, x1: Number.NEGATIVE_INFINITY }, 'FF', rowH)).toBe('');
    expect(linkPath(pred, { ...to, y: Number.NaN }, 'FS', rowH)).toBe('');
    expect(linkPath(pred, to, 'FS', Number.NaN)).toBe('');
    expect(linkPath(pred, to, 'FS', rowH, Number.NaN)).toBe('');
    expect(linkPath(pred, to, 'FS', rowH)).not.toBe('');
  });
});

describe('in a browser far from the plan’s zone (Review Focus 4)', () => {
  const prev = process.env.TZ;

  afterEach(() => {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
    vi.resetModules();
  });

  it.each(['Asia/Tokyo', 'America/Chicago', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])(
    'labels and places the same in %s', async (zone) => {
      process.env.TZ = zone;
      vi.resetModules();
      const geo = await import('./ganttGeometry');
      // the zone took: a local getter would read another hour here
      expect(new Date(Date.UTC(2026, 10, 2)).getHours() === 0).toBe(false);

      const days = geo.makeScale('2026-11-02T08:00', '2026-11-06T17:00', 'days');
      expect(days.startMs).toBe(Date.UTC(2026, 9, 31));
      expect(geo.xOf(days, '2026-11-02T08:00')).toBe(112);
      const tier = geo.tiers(days, 'days');
      expect(labels(tier.top)).toEqual(["Oct 26, '26", "Nov 2, '26", "Nov 9, '26"]);
      expect(labels(tier.bottom).join('')).toBe('SSMTWTFSSMT');

      const hours = geo.tiers(geo.makeScale('2026-11-02T20:00', '2026-11-03T01:00', 'hours'), 'hours');
      expect(labels(hours.top)).toEqual(['Mon 11/2', 'Tue 11/3']);
      expect(labels(hours.bottom)[0]).toBe('18');

      const weeks = geo.tiers(geo.makeScale('2026-11-02T08:00', '2026-12-04T17:00', 'weeks'), 'weeks');
      expect(labels(weeks.top)[1]).toBe('November 2026');
      expect(labels(weeks.bottom)).toContain('11/2');
    });
});
