// @vitest-environment jsdom
/**
 * Distribution: the dashboards' "by status" card. With `limit`, the rows
 * list only the statuses with the most assets (largest first), so a long
 * status vocabulary can't stretch the panel; the color strip still shows
 * the whole fleet.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { DailyBars, Distribution, type DayPoint, type DistEntry } from './charts';

afterEach(cleanup);

const entries: DistEntry[] = Array.from({ length: 12 }, (_, i) => ({
  key: `s${i}`, label: `Status ${i}`, color: '#000', count: i + 1,
}));
const total = entries.reduce((n, e) => n + e.count, 0);

const rowLabels = (container: HTMLElement) =>
  [...container.querySelectorAll('.dash-dist-label')].map((n) => n.textContent);

it('shows every status when no limit is given', () => {
  const { container } = render(<Distribution entries={entries} total={total} />);
  expect(rowLabels(container)).toHaveLength(12);
});

it('lists only the top statuses by count, largest first, when limited', () => {
  // entries arrive in no particular order; the limit keeps the biggest
  const shuffled = [...entries].reverse().sort((a, b) => (a.key < b.key ? -1 : 1));
  const { container } = render(<Distribution entries={shuffled} total={total} limit={8} />);
  expect(rowLabels(container)).toEqual(
    ['Status 11', 'Status 10', 'Status 9', 'Status 8', 'Status 7', 'Status 6', 'Status 5', 'Status 4']);
});

it('keeps the whole fleet in the color strip', () => {
  const { container } = render(<Distribution entries={entries} total={total} limit={8} />);
  expect(container.querySelectorAll('.dash-strip .seg')).toHaveLength(12);
  expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Status 0 1');
});

it('drops zero-count statuses before applying the limit', () => {
  const withZeros = [...entries, { key: 'z', label: 'Zero', color: '#000', count: 0 }];
  const { container } = render(<Distribution entries={withZeros} total={total} limit={20} />);
  expect(rowLabels(container)).not.toContain('Zero');
  expect(rowLabels(container)).toHaveLength(12);
});

/* DailyBars: the SVG stretches to the panel (preserveAspectRatio="none"),
 * so day labels are page text under it, not SVG text that would stretch
 * with the bars. */
const days: DayPoint[] = Array.from({ length: 14 }, (_, i) => ({
  key: `d${i}`, label: `Oct ${i + 1}`, value: i % 3,
}));

it('renders the day labels as text outside the stretched SVG', () => {
  const { container } = render(
    <DailyBars days={days} ariaLabel="Scans" formatTooltip={(d) => `${d.value}`} />);
  expect(container.querySelectorAll('svg text')).toHaveLength(0);
  const labels = [...container.querySelectorAll('.dash-axis .dash-axis-label')];
  expect(labels.map((n) => n.textContent)).toEqual(['Oct 1', 'Oct 5', 'Oct 9', 'Oct 14']);
  // each label sits at its bar's center, as a share of the chart width
  expect((labels[0] as HTMLElement).style.left).toBe(`${(0.5 / 14) * 100}%`);
});

it('shows one tooltip: no native SVG title, per-day counts kept for screen readers', () => {
  const { container } = render(
    <DailyBars days={days} ariaLabel="Scans" formatTooltip={(d) => `${d.value} scans — ${d.label}`} />);
  expect(container.querySelectorAll('svg title')).toHaveLength(0);
  const items = [...container.querySelectorAll('.dash-sr-list li')].map((n) => n.textContent);
  expect(items).toHaveLength(14);
  expect(items[0]).toBe('0 scans — Oct 1');
});
