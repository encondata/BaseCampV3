import { expect, it } from 'vitest';

import { TIME_COLUMN_GUIDE, TIME_IMPORT_ERRORS, TIME_IMPORT_LIMIT_NOTE } from './timeImport';

it('the column guide lists exactly the API columns, in order', () => {
  expect(TIME_COLUMN_GUIDE.map((c) => c.key)).toEqual(
    ['worker', 'clock_in', 'clock_out', 'break_minutes', 'job', 'site', 'notes']);
  expect(TIME_COLUMN_GUIDE.filter((c) => c.required).map((c) => c.key))
    .toEqual(['worker', 'clock_in', 'clock_out']);
});

it('every error the routes send has a sentence', () => {
  for (const code of ['unknown_columns', 'too_many_rows', 'file_too_large', 'invalid_json',
    'invalid_csv', 'invalid_xlsx', 'unsupported_file', 'missing_file', 'invalid_row_numbers',
    'invalid_overrides', 'invalid_skip', 'rows_invalid', 'forbidden']) {
    expect(TIME_IMPORT_ERRORS[code], code).toMatch(/\.$/);
  }
  expect(TIME_IMPORT_LIMIT_NOTE).toBe('Uploads are limited to 5,000 rows and 5 MB. Split larger files before uploading.');
});
