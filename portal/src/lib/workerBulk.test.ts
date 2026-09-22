import { expect, it } from 'vitest';

import { WORKER_BULK_ERRORS, WORKER_COLUMN_GUIDE } from './workerBulk';

it('describes exactly the template columns, names first and required', () => {
  expect(WORKER_COLUMN_GUIDE.map((c) => c.key)).toEqual([
    'first_name', 'last_name', 'preferred_name', 'email', 'phone', 'job_title',
    'employee_number', 'rfid_tag', 'address_line1', 'address_line2', 'city', 'region',
    'postal_code', 'country', 'partner', 'trade', 'level', 'status', 'status_note', 'notes',
  ]);
  expect(WORKER_COLUMN_GUIDE.filter((c) => c.required).map((c) => c.key))
    .toEqual(['first_name', 'last_name']);
});

it('maps every error code the bulk endpoints can raise', () => {
  // mirrors BulkImportError codes in api/src/serversherpa/imports/bulk.py and
  // people/bulk_import.py plus the route-level invalid_json/missing_file and the gate's forbidden
  expect(Object.keys(WORKER_BULK_ERRORS).sort()).toEqual([
    'file_too_large', 'forbidden', 'invalid_csv', 'invalid_json', 'invalid_xlsx',
    'missing_file', 'rows_invalid', 'too_many_rows', 'unknown_columns',
    'unsupported_file',
  ]);
});
