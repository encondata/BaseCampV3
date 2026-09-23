// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import ActivityHistory from './ActivityHistory';
import type { MyActivityItem } from '../lib/api';
import { LIST_FIT } from '../lib/listTools';

/** ActivityHistory reads `preferences.list_size` for the shared column floors
 *  (listScale, lib/listTools); nothing else in this tree touches auth. */
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ preferences: { list_size: 'default' } }),
}));

afterEach(cleanup);

const ROWS: MyActivityItem[] = [
  { id: 'r1', at: '2026-09-15T10:00:00Z', action: 'site.create', entity_type: 'site',
    entity_id: null, ip: null, by_me: true, actor_name: null, changes: {},
    entity_name: null, entity_summary: {} },
  { id: 'r2', at: '2026-09-15T09:00:00Z', action: 'role.set', entity_type: 'person',
    entity_id: 'p1', ip: null, by_me: false, actor_name: 'Alice Anderson', changes: {},
    entity_name: 'Wan Worker', entity_summary: {} },
];

it('labels by_me rows "You" by default', () => {
  render(<MemoryRouter><ActivityHistory rows={ROWS} /></MemoryRouter>);
  expect(screen.getAllByText('You').length).toBeGreaterThan(0);
  expect(screen.getByText('Alice Anderson')).toBeTruthy();
});

it('labels by_me rows with subjectName when given', () => {
  render(<MemoryRouter><ActivityHistory rows={ROWS} subjectName="Wan Worker" /></MemoryRouter>);
  expect(screen.queryByText('You')).toBeNull();
  expect(screen.getAllByText('Wan Worker').length).toBeGreaterThan(0);
});

it('column floors, shared template + minimum, sideways-scroll card', () => {
  render(<MemoryRouter><ActivityHistory rows={ROWS} /></MemoryRouter>);
  const row = screen.getByText('Alice Anderson').closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^150px/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  // Fit: default columns + trailing (the 30px chevron) ≤ LIST_FIT.page
  // (1172px — .portal-page at a 1512px window, nav expanded).
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
});
