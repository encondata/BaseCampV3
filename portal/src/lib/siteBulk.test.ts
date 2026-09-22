import { expect, it } from 'vitest';

import { SITE_COLUMN_GUIDE } from './siteBulk';

it('describes exactly the template columns, name first and required', () => {
  expect(SITE_COLUMN_GUIDE.map((c) => c.key)).toEqual([
    'name', 'code', 'type', 'status', 'address_line1', 'address_line2', 'city', 'region',
    'postal_code', 'country', 'latitude', 'longitude', 'timezone', 'dc_provider',
    'partner', 'clients', 'notes',
  ]);
  expect(SITE_COLUMN_GUIDE.filter((c) => c.required).map((c) => c.key)).toEqual(['name']);
});
