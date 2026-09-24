/** What each assets bulk-update column accepts. Keys mirror the API's
 *  assets bulk-update COLUMNS (routes/assets.py) — the service test pins
 *  that list, the test beside this file pins this one, and the two must
 *  agree. */
import type { BulkColumnGuide } from '../components/bulk/BulkToolPage';

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
  too_many_rows: 'Too many rows — the limit is 15,000 per upload.',
  file_too_large: 'File too large — the limit is 20 MB.',
  job_not_found: 'That job no longer exists.',
  job_not_editable: 'That job can no longer be changed — start a new upload.',
  rows_invalid: 'Some rows still need attention — resolve or skip them and try again.',
  rule_failed: 'A status rule stopped the update — nothing was applied.',
  forbidden: 'You do not have permission to bulk update assets.',
};
