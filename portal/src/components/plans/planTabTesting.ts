/**
 * Test helpers for the plan tab's component tests (imported by tests only).
 *
 * `findSheet` waits for the task sheet the way a person would see it: the
 * grid, then its rows. The grid appears as soon as the plan loads, but its
 * rows come a render later (the virtualizer measures its box first), and the
 * chart's lanes the same way. A test that read rows right after the grid
 * appeared passed alone and failed under load, when those renders landed
 * in separate tasks.
 */
import { screen, waitFor } from '@testing-library/react';

/** The task sheet once it has drawn its rows (a task's, or the blank
 *  new-task row) and, when the chart is on screen, the chart its lanes.
 *  `rows: false` for a sheet with none to draw (an empty read-only plan). */
export async function findSheet({ rows = true, timeout = 3000 }: { rows?: boolean; timeout?: number } = {}) {
  const grid = await screen.findByRole('grid', { name: 'Task sheet' }, { timeout });
  if (!rows) return grid;
  await waitFor(() => {
    if (!grid.querySelector('[role="row"][data-task], [data-blank]')) throw new Error('the sheet has no rows yet');
    if (document.querySelector('.pln-pane-chart') && !document.querySelector('.pln-lane')) {
      throw new Error('the chart has no lanes yet');
    }
  }, { timeout });
  return grid;
}
