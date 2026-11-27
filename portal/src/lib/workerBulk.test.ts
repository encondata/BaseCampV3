import { expect, it } from 'vitest';

import { WORKER_BULK_ERRORS, WORKER_COLUMN_GUIDE } from './workerBulk';

it('describes exactly the export columns, names first and required', () => {
  expect(WORKER_COLUMN_GUIDE.map((c) => c.key)).toEqual([
    'person_id', 'first_name', 'last_name', 'preferred_name', 'email', 'phone', 'job_title',
    'employee_number', 'rfid_tag', 'address_line1', 'address_line2', 'city', 'region',
    'postal_code', 'country', 'partner', 'trade', 'level', 'status', 'status_note', 'notes',
    'will_travel', 'travel_region', 'travel_restrictions',
    'badge_uid', 'has_photo', 'source', 'source_ref', 'has_login', 'login_email',
    'login_disabled', 'last_login_at', 'roles', 'created_at', 'updated_at',
    'profile_updated_at', 'certifications',
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

it('says a hand-edited JSON file must be a list of rows', () => {
  expect(WORKER_BULK_ERRORS.invalid_json)
    .toBe('That JSON file could not be read — it must be a list of rows.');
});
