// @vitest-environment jsdom
/** The summary's Result column (7th) carries the outcome tint, and the
 *  sites-summary tints bulk.css puts on the 3rd/4th cells (Load / Truck
 *  here) are reset. jsdom cascades the real stylesheets (no var()
 *  resolution, so the declared values are compared). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, it } from 'vitest';

import type { MacroPointApplyResult } from '../../lib/api';
import MacroPointSummary from './MacroPointSummary';

const result: MacroPointApplyResult = {
  added: 1, duplicates: 0, skipped: 0, errors: 1, status_changes: 0,
  rows: [
    { row: 1, source: 'a.eml', group_key: 'order:tok', id_number: 'LOAD 1', truck_id: 't1', truck_name: 'JP Truck',
      kind: 'location', recorded_at: '2024-10-15T15:11:00Z', detail: '1, 2', result: 'added',
      status_change: null, reason: null, note: null },
    { row: 2, source: 'b.eml', group_key: 'order:tok', id_number: 'LOAD 1', truck_id: 't9', truck_name: 'Gone Truck',
      kind: 'location', recorded_at: '2024-10-15T16:11:00Z', detail: '3, 4', result: 'error',
      status_change: null, reason: 'truck_not_active', note: null },
  ],
};

beforeAll(() => {
  const css = ['../../styles/bulk.css', '../../styles/macropoint.css']
    .map((f) => readFileSync(resolve(__dirname, f), 'utf8')).join('\n');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
});
afterEach(cleanup);

const cells = (name: string) => within(screen.getByText(name).closest('tr')!).getAllByRole('cell');
const color = (el: Element) => getComputedStyle(el).color;

it('tints Result per outcome and leaves Load / Truck untinted', () => {
  render(<MacroPointSummary result={result} />);
  const added = cells('JP Truck');
  const error = cells('Gone Truck');
  expect(added[6].textContent).toBe('Added');
  expect(error[6].textContent).toBe('Error');
  expect(color(added[6])).toMatch(/c-green|23, 138, 76|#178a4c/i);
  expect(color(error[6])).toMatch(/c-red|192, 53, 64|#c03540/i);
  for (const td of [added[2], added[3], error[2], error[3]]) {
    expect(color(td)).not.toMatch(/c-green|c-red|23, 138, 76|192, 53, 64/i);
  }
});
