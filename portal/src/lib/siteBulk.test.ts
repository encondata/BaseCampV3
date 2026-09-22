import { expect, it } from 'vitest';

import { SITE_BULK_ERRORS, SITE_COLUMN_GUIDE } from './siteBulk';

it('describes exactly the template columns, name first and required', () => {
  expect(SITE_COLUMN_GUIDE.map((c) => c.key)).toEqual([
    'name', 'code', 'type', 'status', 'address_line1', 'address_line2', 'city', 'region',
    'postal_code', 'country', 'latitude', 'longitude', 'timezone', 'dc_provider',
    'partner', 'clients', 'notes',
  ]);
  expect(SITE_COLUMN_GUIDE.filter((c) => c.required).map((c) => c.key)).toEqual(['name']);
});

it('maps every error code the bulk endpoints can raise', () => {
  // mirrors BulkImportError codes in api/src/serversherpa/sites/bulk_import.py
  // plus the route-level invalid_json and the gate's forbidden
  expect(Object.keys(SITE_BULK_ERRORS).sort()).toEqual([
    'file_too_large', 'forbidden', 'invalid_csv', 'invalid_json', 'invalid_xlsx',
    'missing_file', 'rows_invalid', 'too_many_rows', 'unknown_columns',
    'unsupported_file',
  ]);
});
