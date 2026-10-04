// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import CheckList from './CheckList';

afterEach(cleanup);

it('shows each check with its chip, label and value', () => {
  render(<CheckList label="Cloudflare test" checks={[
    { label: 'Zone', status: 'pass', value: 'serversherpa.com' },
    { label: 'Public IP', status: 'warn', value: '0 A records point at it' },
  ]} />);
  const list = screen.getByRole('list', { name: 'Cloudflare test' });
  const items = within(list).getAllByRole('listitem');
  expect(items.map((i) => i.textContent)).toEqual([
    'PassZoneserversherpa.com', 'WarningPublic IP0 A records point at it']);
});
