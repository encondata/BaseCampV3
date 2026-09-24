import { expect, it } from 'vitest';

import { ApiError, type AssetBulkJob } from './api';
import {
  ASSET_BULK_COLUMN_GUIDE, ASSET_BULK_ERRORS, assetBulkError, assetBulkFailure,
} from './assetBulk';

it('describes exactly the template columns, in the API column order', () => {
  expect(ASSET_BULK_COLUMN_GUIDE.map((c) => c.key)).toEqual([
    'asset_id', 'serial_number', 'name', 'new_serial_number', 'rfid_tag', 'make', 'model',
    'client', 'site', 'location', 'pod', 'status', 'has_rails',
  ]);
});

it('maps every error code the bulk-update endpoints can raise', () => {
  expect(Object.keys(ASSET_BULK_ERRORS).sort()).toEqual([
    'apply_conflict', 'empty_file', 'file_too_large', 'forbidden', 'invalid_approved',
    'invalid_csv', 'invalid_json', 'invalid_overrides', 'invalid_skip', 'invalid_xlsx',
    'job_not_cancellable', 'job_not_editable', 'job_not_found', 'missing_file', 'rows_invalid',
    'rule_failed', 'too_many_rows', 'unknown_columns', 'unknown_format', 'unsupported_file',
  ]);
});

it('every message is a sentence', () => {
  for (const text of Object.values(ASSET_BULK_ERRORS)) expect(text).toMatch(/^[A-Z].*\.$/);
});

it('turns a finished job into one sentence per failure', () => {
  const base = { status: 'failed', results: null } as unknown as AssetBulkJob;
  const failed = (over: object) => ({ ...base, ...over }) as AssetBulkJob;
  expect(assetBulkFailure(failed({ error: 'rule_failed', results: { row: 7, rule_name: 'Close', message: 'x' } })))
    .toBe('Row 7: the status rule “Close” stopped the update — nothing was applied.');
  expect(assetBulkFailure(failed({ error: 'apply_conflict', results: { message: 'x' } })))
    .toBe(ASSET_BULK_ERRORS.apply_conflict);
  expect(assetBulkFailure(failed({ error: 'rows_invalid', results: { rows: [] } })))
    .toBe(ASSET_BULK_ERRORS.rows_invalid);
  expect(assetBulkFailure(failed({ status: 'cancelled', error: null })))
    .toBe('The update was canceled — nothing was applied.');
  expect(assetBulkFailure(failed({ error: 'worker_crashed' })))
    .toBe('The update failed — nothing was applied. Try again.');
  expect(assetBulkFailure(null)).toBe('The update failed — nothing was applied. Try again.');
});

it('maps API errors to sentences and anything else to a network error', () => {
  expect(assetBulkError(new ApiError(422, 'empty_file'))).toBe('That file is empty.');
  expect(assetBulkError(new ApiError(500, 'boom'))).toBe('That did not work — try again.');
  expect(assetBulkError(new TypeError('fetch failed'))).toBe('Network error.');
});
