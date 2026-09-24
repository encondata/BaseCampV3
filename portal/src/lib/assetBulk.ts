/** What each assets bulk-update column accepts. Keys mirror the API's
 *  assets bulk-update COLUMNS (routes/assets.py) — the service test pins
 *  that list, the test beside this file pins this one, and the two must
 *  agree. */
import type { BulkColumnGuide } from '../components/bulk/BulkToolPage';
import { ApiError, type AssetBulkCompletedResults, type AssetBulkJob } from './api';

export const ASSET_BULK_COLUMN_GUIDE: BulkColumnGuide[] = [
  { key: 'asset_id', required: false,
    accepts: 'The Asset ID. Pins the asset directly. Provide this or serial_number.', example: '4821' },
  { key: 'serial_number', required: false,
    accepts: 'The asset\'s current serial number. Finds the asset when Asset ID is blank; case does not matter. '
      + 'Provide this or asset_id.', example: 'SN-88231' },
  { key: 'name', required: false, accepts: 'New name for the asset. Blank leaves the name alone.', example: 'Rack Unit 12' },
  { key: 'new_serial_number', required: false,
    accepts: 'A new serial number for the asset. Allowed only on rows with an Asset ID.', example: 'SN-99001' },
  { key: 'rfid_tag', required: false,
    accepts: 'RFID tag. Letters and numbers only, up to 24 characters; spaces are ignored and case does not matter. '
      + 'A tag already on another asset is an error.', example: 'A1B2C3' },
  { key: 'make', required: false,
    accepts: 'The asset\'s make. Provide together with model; unknown or shared pairs can be picked in the preview.',
    example: 'Dell' },
  { key: 'model', required: false,
    accepts: 'The asset\'s model. Provide together with make; unknown or shared pairs can be picked in the preview.',
    example: 'PowerEdge R740' },
  { key: 'client', required: false, accepts: 'An existing, non-archived client by name.', example: 'Acme Corp' },
  { key: 'site', required: false, accepts: 'An existing, non-archived site by name.', example: 'Example DC West' },
  { key: 'location', required: false, accepts: 'Free text location detail.', example: 'Row 4, Rack 12' },
  { key: 'pod', required: false, accepts: 'Free text pod number.', example: 'Pod 3' },
  { key: 'status', required: false, accepts: 'An active asset status, by key or label.', example: 'in_transit' },
  { key: 'has_rails', required: false,
    accepts: 'yes or no (also true/false, y/n, 1/0). Blank leaves it alone.', example: 'yes' },
];

export const ASSET_BULK_ERRORS: Record<string, string> = {
  unknown_columns: 'The file has columns that are not in the template.',
  unknown_format: 'Choose CSV or Excel for the download.',
  too_many_rows: 'Too many rows — the limit is 15,000 per upload.',
  file_too_large: 'File too large — the limit is 20 MB.',
  invalid_csv: 'That CSV could not be read.',
  invalid_xlsx: 'That spreadsheet could not be read.',
  unsupported_file: 'Unsupported file type — use .csv or .xlsx.',
  missing_file: 'Choose a file first.',
  empty_file: 'That file is empty.',
  invalid_json: 'The server could not read the request — upload the file again.',
  invalid_overrides: 'The preview is out of date — upload the file again.',
  invalid_skip: 'The preview is out of date — upload the file again.',
  invalid_approved: 'The preview is out of date — upload the file again.',
  job_not_found: 'That job no longer exists.',
  job_not_editable: 'That job can no longer be changed — start a new upload.',
  job_not_cancellable: 'That update has already started and can no longer be canceled.',
  rows_invalid: 'Some rows changed and now need attention — nothing was applied. Upload the file again to review them.',
  rule_failed: 'A status rule stopped the update — nothing was applied.',
  apply_conflict: 'Something changed while the update ran (a serial number or RFID tag was taken, '
    + 'for example) — nothing was applied. Upload the file again to see the current values.',
  forbidden: 'You do not have permission to bulk update assets.',
};

const APPLY_FAILED = 'The update failed — nothing was applied. Try again.';

type Placement = NonNullable<AssetBulkCompletedResults['summary']['placement']>;

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The rack-placement recheck a completed job ran, as one sentence (null: none ran). */
export function placementNote(placement: Placement | undefined): string | null {
  if (!placement) return null;
  return 'Rack placement was rechecked on the moves holding these assets: '
    + `${count(placement.collisions, 'collision', 'collisions')}, `
    + `${count(placement.orphans, 'orphan node', 'orphan nodes')}, and `
    + `${count(placement.cleared, 'flag', 'flags')} cleared.`;
}

/** Why a finished job did not apply, as one sentence (null: the job could not be read). */
export function assetBulkFailure(job: AssetBulkJob | null): string {
  if (!job) return APPLY_FAILED;
  if (job.status === 'cancelled') return 'The update was canceled — nothing was applied.';
  if (job.error === 'rule_failed') {
    return `Row ${job.results.row}: the status rule “${job.results.rule_name}” stopped the update`
      + ' — nothing was applied.';
  }
  return (job.error && ASSET_BULK_ERRORS[job.error]) || APPLY_FAILED;
}

/** An API call's failure as one sentence. */
export function assetBulkError(err: unknown): string {
  return err instanceof ApiError
    ? (ASSET_BULK_ERRORS[err.code] ?? 'That did not work — try again.')
    : 'Network error.';
}
