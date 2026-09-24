import { expect, it } from 'vitest';

import { ApiError, type AssetBulkJob } from './api';
import {
  ASSET_BULK_COLUMN_GUIDE, ASSET_BULK_ERRORS, assetBulkError, assetBulkFailure, placementNote,
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
    .toBe('Some rows changed and now need attention — nothing was applied. '
      + 'Upload the file again to review them.');
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

it('describes the placement recheck as one sentence, pluralized, or nothing when none ran', () => {
  expect(placementNote(undefined)).toBeNull();
  expect(placementNote({ collisions: 2, orphans: 0, cleared: 1 })).toBe(
    'Rack placement was rechecked on the moves holding these assets: '
    + '2 collisions, 0 orphan nodes, and 1 flag cleared.');
  expect(placementNote({ collisions: 1, orphans: 1, cleared: 1200 })).toBe(
    'Rack placement was rechecked on the moves holding these assets: '
    + '1 collision, 1 orphan node, and 1,200 flags cleared.');
});
