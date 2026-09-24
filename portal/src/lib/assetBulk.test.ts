import { expect, it } from 'vitest';

import { ASSET_BULK_COLUMN_GUIDE, ASSET_BULK_ERRORS } from './assetBulk';

it('describes exactly the template columns, in the API column order', () => {
  expect(ASSET_BULK_COLUMN_GUIDE.map((c) => c.key)).toEqual([
    'asset_id', 'serial_number', 'name', 'new_serial_number', 'rfid_tag', 'make', 'model',
    'client', 'site', 'location', 'pod', 'status', 'has_rails',
  ]);
});

it('maps every error code the bulk-update endpoints can raise', () => {
  expect(Object.keys(ASSET_BULK_ERRORS).sort()).toEqual([
    'file_too_large', 'forbidden', 'job_not_editable', 'job_not_found', 'rows_invalid',
    'rule_failed', 'too_many_rows', 'unknown_columns',
  ]);
});
