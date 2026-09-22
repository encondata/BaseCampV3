import { expect, it } from 'vitest';

import { TRUCK_BULK_ERRORS, TRUCK_COLUMN_GUIDE } from './truckBulk';

it('describes exactly the template columns, name first and required', () => {
  expect(TRUCK_COLUMN_GUIDE.map((c) => c.key)).toEqual([
    'name', 'status', 'driver_name', 'co_driver_name', 'team_drive', 'contact_info',
    'load_number', 'seal_id', 'tracking_type', 'tracking_update_type', 'tracker_id',
    'initiative', 'start_site', 'end_site', 'containers',
  ]);
  expect(TRUCK_COLUMN_GUIDE.filter((c) => c.required).map((c) => c.key)).toEqual(['name']);
});

it('maps every error code the bulk endpoints can raise', () => {
  expect(Object.keys(TRUCK_BULK_ERRORS).sort()).toEqual([
    'file_too_large', 'forbidden', 'invalid_csv', 'invalid_json', 'invalid_xlsx',
    'missing_file', 'rows_invalid', 'too_many_rows', 'unknown_columns', 'unsupported_file',
  ]);
});
