/** Copy for the assign-workers-from-a-template tool. Column keys mirror the
 *  API's COLUMNS list (api/src/.../assign_bulk); the test beside this file
 *  pins this side. */
import type { BulkColumnGuide } from '../components/bulk/BulkToolPage';
import type { AssignFlagKind } from './api';

export const ASSIGN_COLUMN_GUIDE: BulkColumnGuide[] = [
  { key: 'first_name', required: true, accepts: 'The worker\'s first name.', example: 'Marcus' },
  { key: 'last_name', required: true, accepts: 'The worker\'s last name.', example: 'Reyes' },
  { key: 'preferred_name', required: false, accepts: 'The name they go by, if different from the first name.', example: 'Marc' },
  { key: 'phone', required: false, accepts: 'A phone number. Formatting does not matter.', example: '555-555-0102' },
  { key: 'email', required: false, accepts: 'An email address.', example: 'marcus.reyes@example.com' },
  { key: 'role', required: false, accepts: 'A role name (case does not matter). Blank means Tech. Unknown names can be set in the preview.', example: 'Lead' },
];

export const ASSIGN_BULK_ERRORS: Record<string, string> = {
  unknown_columns: 'The file has columns that are not in the template.',
  too_many_rows: 'Too many rows — the limit is 1,000 per upload.',
  file_too_large: 'File too large — the limit is 5 MB.',
  invalid_json: 'The server could not read the rows — preview again.',
  invalid_csv: 'That CSV could not be read.',
  invalid_xlsx: 'That spreadsheet could not be read.',
  unsupported_file: 'Unsupported file type — use .csv or .xlsx.',
  missing_file: 'Choose a file first.',
  invalid_row_numbers: 'The preview is out of date — upload the file again.',
  invalid_decisions: 'The preview is out of date — upload the file again.',
  rows_invalid: 'Some rows still need attention — resolve them and try again.',
  partner_not_found: 'That partner no longer exists.',
  partner_archived: 'That partner is archived — pick another.',
  site_not_found: 'That site no longer exists.',
  site_archived: 'That site is archived — pick another.',
  initiative_archived: 'That job is archived — unarchive it first.',
  initiative_not_found: 'That job no longer exists.',
  forbidden: 'You do not have permission to assign workers.',
};

export const FLAG_TEXT: Record<AssignFlagKind, string> = {
  needs_match: 'No worker matched. Pick one or create a new worker.',
  role_unknown: 'The role in the sheet is not a known role. Pick one.',
  name_differs: 'Name differs: matched by email or phone to someone with another name.',
  contact: 'Discrepancy: the sheet\'s contact details differ from the person on file.',
  partner: 'Discrepancy: this worker is with a different partner.',
  status: 'This worker\'s status is not Active.',
  assignment: 'Already on this initiative with a different site or role.',
  shared_contact: 'Contact details shared with another person.',
  no_contact: 'No phone or email in the sheet.',
  phone_invalid: 'The phone number could not be read.',
};
