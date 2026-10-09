// @vitest-environment jsdom
/**
 * Distribution: the dashboards' "by status" card. With `limit`, the rows
 * list only the statuses with the most assets (largest first), so a long
 * status vocabulary can't stretch the panel; the color strip still shows
 * the whole fleet.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { Distribution, type DistEntry } from './charts';

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
