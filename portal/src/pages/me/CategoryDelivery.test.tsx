// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import type { MyNotificationGroup, NotifPrefs } from '../../lib/api';
import CategoryDelivery from './CategoryDelivery';

afterEach(cleanup);

const CHOICES: NotifPrefs['categories'] = {
  approvals: 'email', reports: 'email', wiki: 'email', learning: 'email', plans: 'email',
  security: 'email',
};

const emailFrom = (
  categories: NotifPrefs['categories'], groups: MyNotificationGroup[] | null = [],
) => {
  render(<CategoryDelivery categories={categories} groups={groups} onChange={() => {}} />);
  const row = screen.getByText('Project plans').closest('tr') as HTMLElement;
  return within(row);
};

it('Project plans says the mail is sent to the contact email when the choice is Inbox + Email', () => {
  const row = emailFrom(CHOICES);
  expect(row.getByText('Sent to your contact email')).toBeTruthy();
  expect(row.queryByText('No group — inbox only')).toBeNull();
});

it('Project plans shows the direct note even while the groups are still loading', () => {
  expect(emailFrom(CHOICES, null).getByText('Sent to your contact email')).toBeTruthy();
});

it.each(['inbox', 'off'] as const)('Project plans shows a dash when the choice is %s', (choice) => {
  const row = emailFrom({ ...CHOICES, plans: choice });
  expect(row.queryByText('Sent to your contact email')).toBeNull();
  expect(row.queryByText('No group — inbox only')).toBeNull();
  expect(row.getByText('—')).toBeTruthy();
});

it('every other category still reads from the groups', () => {
  render(<CategoryDelivery categories={CHOICES} groups={[]} onChange={() => {}} />);
  const row = screen.getByText('Wiki').closest('tr') as HTMLElement;
  expect(within(row).getByText('No group — inbox only')).toBeTruthy();
});
