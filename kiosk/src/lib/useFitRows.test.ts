// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { fitRows } from './useFitRows';

function box(el: HTMLElement, top: number, bottom: number) {
  el.getBoundingClientRect = () => ({ top, bottom } as DOMRect);
}

function panel(bottoms: number[]) {
  const container = document.createElement('div');
  box(container, 0, 100);
  const rows = bottoms.map((b) => {
    const row = document.createElement('div');
    row.setAttribute('data-fit-row', '');
    box(row, b - 20, b);
    container.appendChild(row);
    return row;
  });
  return { container, rows };
}

describe('fitRows', () => {
  it('hides the first row that would be cut off and every row after it', () => {
    const { container, rows } = panel([20, 40, 60, 80, 100, 120, 140]);
    fitRows(container);
    expect(rows.map((r) => r.style.visibility)).toEqual(['', '', '', '', '', 'hidden', 'hidden']);
  });

  it('shows rows again once there is room', () => {
    const { container, rows } = panel([20, 40, 120]);
    fitRows(container);
    expect(rows[2].style.visibility).toBe('hidden');
    box(container, 0, 200);
    fitRows(container);
    expect(rows.map((r) => r.style.visibility)).toEqual(['', '', '']);
  });

  it('ignores elements that are not rows', () => {
    const { container, rows } = panel([20]);
    const other = document.createElement('p');
    box(other, 0, 500);
    container.appendChild(other);
    fitRows(container);
    expect(rows[0].style.visibility).toBe('');
    expect(other.style.visibility).toBe('');
  });
});
