/** What each workers bulk-import column accepts. Keys mirror the API's
 *  people/bulk_import.py COLUMNS — the service test pins that list, the
 *  test beside this file pins this one, and the two must agree. */
export interface WorkerColumnGuide { key: string; required: boolean; accepts: string; example: string }

export const WORKER_COLUMN_GUIDE: WorkerColumnGuide[] = [
  { key: 'first_name', required: true, accepts: 'Given name. With last_name, matches an existing person by name.', example: 'Robert' },
  { key: 'last_name', required: true, accepts: 'Family name.', example: 'Smith' },
  { key: 'preferred_name', required: false, accepts: 'What the person goes by. With last_name, also matches by name.', example: 'Bob' },
  { key: 'email', required: false, accepts: 'An email address. Matches an existing person by email (case does not matter).', example: 'bob.smith@example.com' },
  { key: 'phone', required: false, accepts: 'Any format with at least 7 digits. Matches an existing person by the digits.', example: '555-123-4567' },
  { key: 'job_title', required: false, accepts: 'Free text.', example: 'Lead Technician' },
  { key: 'employee_number', required: false, accepts: 'Badge or employee number, free text.', example: 'E1042' },
  { key: 'rfid_tag', required: false, accepts: 'Tap-in badge tag. Must not belong to another person.', example: '' },
  { key: 'address_line1', required: false, accepts: 'Street address.', example: '12 Rack Row' },
  { key: 'address_line2', required: false, accepts: 'Suite, floor, building.', example: '' },
  { key: 'city', required: false, accepts: 'Free text.', example: 'Reno' },
  { key: 'region', required: false, accepts: 'State or province.', example: 'NV' },
  { key: 'postal_code', required: false, accepts: 'Free text.', example: '89501' },
  { key: 'country', required: false, accepts: 'Two-letter code. Blank means US for new workers.', example: 'US' },
  { key: 'partner', required: false, accepts: 'An existing partner name from the Reference sheet. Blank means direct hire.', example: '' },
  { key: 'trade', required: false, accepts: 'Free text.', example: 'Cable, Rack & Stack' },
  { key: 'level', required: false, accepts: 'A level key from the Reference sheet (L1 to L6).', example: 'L4' },
  { key: 'status', required: false, accepts: 'A worker status from the Reference sheet. Blank means active for new workers.', example: 'active' },
  { key: 'status_note', required: false, accepts: 'Free text. Required when status is blacklist.', example: '' },
  { key: 'notes', required: false, accepts: 'Free text.', example: '' },
];

export const WORKER_BULK_ERRORS: Record<string, string> = {
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
