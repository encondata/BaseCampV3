// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';

import ActivityHistory from './ActivityHistory';
import type { MyActivityItem } from '../lib/api';

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
