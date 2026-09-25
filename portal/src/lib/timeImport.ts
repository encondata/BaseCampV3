/** What each Add-time-punches column accepts. Keys mirror the API's
 *  people/time_bulk.py COLUMNS; the service test pins that list, the test
 *  beside this file pins this one, and the two must agree. */
import type { BulkColumnGuide } from '../components/bulk/BulkToolPage';

export const TIME_COLUMN_GUIDE: BulkColumnGuide[] = [
  { key: 'worker', required: true, accepts: 'The worker\'s email, phone, or full name. Email wins, then phone, then name. Unknown or shared values can be matched in the preview.', example: 'Marcus Reyes' },
  { key: 'clock_in', required: true, accepts: 'A date and time, such as 9/24/2026 7:00 AM or 2026-09-24 07:00, an Excel date-time cell, or ISO 8601 with an offset. Without an offset it is read in the row\'s site time zone.', example: '9/24/2026 7:00 AM' },
  { key: 'clock_out', required: true, accepts: 'The same formats as clock_in. It must be after clock_in, and a shift can be at most 24 hours.', example: '9/24/2026 3:30 PM' },
  { key: 'break_minutes', required: false, accepts: 'A whole number of minutes, 0 or more, shorter than the shift. Blank means 0.', example: '30' },
  { key: 'job', required: false, accepts: 'An existing job, by name. Case does not matter.', example: 'Example Move' },
  { key: 'site', required: false, accepts: 'An existing site, by name or code. Its time zone reads the times; when blank, the job\'s site is used, then Eastern time.', example: 'Example DC West' },
  { key: 'notes', required: false, accepts: 'Free text.', example: '' },
];

export const TIME_IMPORT_ERRORS: Record<string, string> = {
  unknown_columns: 'The file has columns that are not in the template (worker, clock_in, clock_out, break_minutes, job, site, notes).',
  too_many_rows: 'Too many rows. The limit is 5,000 per upload.',
  file_too_large: 'File too large. The limit is 5 MB.',
  invalid_json: 'The server could not read the rows. Preview again.',
  invalid_csv: 'That CSV could not be read.',
  invalid_xlsx: 'That spreadsheet could not be read.',
  unsupported_file: 'Unsupported file type. Use .csv or .xlsx.',
  missing_file: 'Choose a file first.',
  invalid_row_numbers: 'The preview is out of date. Upload the file again.',
  invalid_overrides: 'The preview is out of date. Upload the file again.',
  invalid_skip: 'The preview is out of date. Upload the file again.',
  rows_invalid: 'Some rows need attention, or a shift now overlaps time added since the preview. Preview again, then resolve or skip those rows.',
  forbidden: 'You do not have permission to add time in bulk.',
  busy: 'Time entries are being changed right now. Try again in a moment.',
  nothing_to_add: 'Every shift in this file is already there or was skipped.',
};

export const TIME_IMPORT_LIMIT_NOTE = 'Uploads are limited to 5,000 rows and 5 MB. Split larger files before uploading.';
