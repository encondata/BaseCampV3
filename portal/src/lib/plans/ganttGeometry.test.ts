/** Gantt geometry: plan times to pixels, tiers, bars and link paths. Pure
 *  functions over floating plan times (UTC-naive, see floatingTime.ts), so a
 *  tick label never depends on the browser's zone (Review Focus 4). */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fromMs, toMs } from './floatingTime';
import {
  baselineOf, barOf, fitZoom, linkPath, makeScale, msOf, progressWidth, tiers, xOf,
  ZOOM_PX_PER_DAY, ZOOMS, zoomIn, zoomOut, type Scale, type Zoom,
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
  it('picks the finest zoom that fits the width', () => {
    expect(fitZoom('2026-11-02T08:00', '2026-11-13T17:00', 1000)).toBe('days');
    // twelve hours of work and the padding come to 360px at 480 px/day
    expect(fitZoom('2026-11-02T08:00', '2026-11-02T20:00', 1000)).toBe('hours');
  });

  it('never picks a zoom wider than the pane', () => {
    const pick = fitZoom('2026-11-02', '2027-04-30', 2000);
    expect(pick).toBe('months');
    expect(makeScale('2026-11-02', '2027-04-30', pick).width).toBeLessThanOrEqual(2000);
    expect(makeScale('2026-11-02', '2027-04-30', 'weeks').width).toBeGreaterThan(2000);
  });

  it('falls back to quarters for a plan nothing fits', () => {
    expect(fitZoom('2026-11-02', '2029-11-02', 1000)).toBe('quarters');
    expect(fitZoom('2026-11-02', '2026-11-13', 0)).toBe('quarters');
    expect(fitZoom('2026-11-02', '2026-11-13', Number.NaN)).toBe('quarters');
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

  it('starts every weekly tick on a Monday', () => {
    const scale = makeScale('2026-11-04T08:00', '2027-02-26T17:00', 'weeks');
    for (const t of tiers(scale, 'weeks').bottom) {
      expect(new Date(scale.startMs + t.x / scale.pxPerMs).getUTCDay()).toBe(1);
    }
  });
});

describe('linkPath', () => {
  const pred = { x0: 100, x1: 200, y: 20 };
  const rowH = 40;

  it('runs a forward finish-to-start link out, down and in', () => {
    const path = linkPath(pred, { x0: 300, x1: 400, y: 60 }, 'FS', rowH);
    expect(path).toBe('M 200 20 H 208 V 60 H 300');
    expect(path.match(/[HV]/g)).toHaveLength(3);
  });

  it('detours below the predecessor row when the successor starts left of the stub', () => {
    const path = linkPath(pred, { x0: 150, x1: 250, y: 60 }, 'FS', rowH);
    expect(path).toBe('M 200 20 H 208 V 40 H 142 V 60 H 150');
    expect(path.match(/[HV]/g)).toHaveLength(5);
  });

  it('takes the forward route right at the stub', () => {
    expect(linkPath(pred, { x0: 208, x1: 300, y: 60 }, 'FS', rowH)).toBe('M 200 20 H 208 V 60 H 208');
    expect(linkPath(pred, { x0: 207, x1: 300, y: 60 }, 'FS', rowH).match(/[HV]/g)).toHaveLength(5);
  });

  it('detours above when the successor is on a row above', () => {
    const path = linkPath({ x0: 100, x1: 200, y: 60 }, { x0: 150, x1: 250, y: 20 }, 'FS', rowH);
    expect(path).toBe('M 200 60 H 208 V 40 H 142 V 20 H 150');
  });

  it('starts a start-to-start link at the predecessor’s start and ends at the successor’s start', () => {
    expect(linkPath(pred, { x0: 100, x1: 300, y: 60 }, 'SS', rowH)).toBe('M 100 20 H 92 V 60 H 100');
    expect(linkPath(pred, { x0: 50, x1: 90, y: 60 }, 'SS', rowH)).toBe('M 100 20 H 92 V 40 H 42 V 60 H 50');
  });

  it('starts a finish-to-finish link at the predecessor’s end and ends at the successor’s end', () => {
    expect(linkPath(pred, { x0: 120, x1: 200, y: 60 }, 'FF', rowH)).toBe('M 200 20 H 208 V 60 H 200');
    expect(linkPath(pred, { x0: 250, x1: 300, y: 60 }, 'FF', rowH)).toBe('M 200 20 H 208 V 40 H 308 V 60 H 300');
  });

  it('starts a start-to-finish link at the predecessor’s start and ends at the successor’s end', () => {
    expect(linkPath(pred, { x0: 20, x1: 80, y: 60 }, 'SF', rowH)).toBe('M 100 20 H 92 V 60 H 80');
    expect(linkPath(pred, { x0: 120, x1: 150, y: 60 }, 'SF', rowH)).toBe('M 100 20 H 92 V 40 H 158 V 60 H 150');
  });

  it('rounds to a hundredth of a pixel and takes a narrower stub', () => {
    expect(linkPath({ x0: 0, x1: 100.123456, y: 20 }, { x0: 300.5, x1: 400, y: 60 }, 'FS', rowH))
      .toBe('M 100.12 20 H 108.12 V 60 H 300.5');
    expect(linkPath(pred, { x0: 300, x1: 400, y: 60 }, 'FS', rowH, 3)).toBe('M 200 20 H 203 V 60 H 300');
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
