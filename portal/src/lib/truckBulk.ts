/** What each trucks bulk-import column accepts. Keys mirror the API's
 *  trucks/bulk_import.py COLUMNS — the service test pins that list, the
 *  test beside this file pins this one, and the two must agree. */
export interface TruckColumnGuide { key: string; required: boolean; accepts: string; example: string }

export const TRUCK_COLUMN_GUIDE: TruckColumnGuide[] = [
  { key: 'name', required: true, accepts: 'Truck name. Matches an existing truck by name (case does not matter).', example: 'Truck 12' },
  { key: 'status', required: false, accepts: 'A truck status key from the Reference sheet. Blank means created for new trucks.', example: 'active' },
  { key: 'driver_name', required: false, accepts: 'Free text.', example: 'Marcus Reyes' },
  { key: 'co_driver_name', required: false, accepts: 'Free text.', example: 'Dana Whitfield' },
  { key: 'team_drive', required: false, accepts: 'yes or no. Blank means no for new trucks.', example: 'yes' },
  { key: 'contact_info', required: false, accepts: 'Driver phone or other contact, free text.', example: '+1 (555) 010-2231' },
  { key: 'load_number', required: false, accepts: 'Free text.', example: 'L-1042' },
  { key: 'seal_id', required: false, accepts: 'Up to 24 characters.', example: 'SEAL-88231' },
  { key: 'tracking_type', required: false, accepts: 'How the truck is tracked, free text (gps, cell, none).', example: 'gps' },
  { key: 'tracking_update_type', required: false, accepts: 'How updates arrive, free text (API, manual).', example: 'API' },
  { key: 'tracker_id', required: false, accepts: 'Tracker or device id, free text.', example: 'TRK-0012' },
  { key: 'initiative', required: false, accepts: 'An existing move, project, or event name from the Reference sheet.', example: 'Example Move' },
  { key: 'start_site', required: false, accepts: 'An existing site name from the Reference sheet.', example: 'Example DC West' },
  { key: 'end_site', required: false, accepts: 'An existing site name from the Reference sheet.', example: 'Example Office' },
  { key: 'containers', required: false, accepts: 'Existing container names separated by semicolons. On an update the list replaces what is on the truck.', example: 'Crate A; Crate B' },
];

export const TRUCK_BULK_ERRORS: Record<string, string> = {
  unknown_columns: 'The file has columns that are not in the template.',
  too_many_rows: 'Too many rows — the limit is 1,000 per upload.',
  file_too_large: 'File too large — the limit is 5 MB.',
  invalid_json: 'The server could not read the rows — preview again.',
  invalid_csv: 'That CSV could not be read.',
  invalid_xlsx: 'That spreadsheet could not be read.',
  unsupported_file: 'Unsupported file type — use .csv or .xlsx.',
  missing_file: 'Choose a file first.',
  rows_invalid: 'Some rows have problems — fix them and preview again.',
  forbidden: 'You do not have permission to bulk import.',
};
