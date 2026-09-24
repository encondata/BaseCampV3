/** What each bulk-assign column accepts. Keys mirror the API's
 *  people/team_bulk.py COLUMNS — the service test pins that list, the test
 *  beside this file pins this one, and the two must agree. */
import type { BulkColumnGuide } from '../components/bulk/BulkToolPage';
import type { InitiativeItem } from './api';
import { longDateOf } from './format';
import { parseApiDay } from './timeline';

export const TEAM_COLUMN_GUIDE: BulkColumnGuide[] = [
  { key: 'worker', required: true, accepts: 'A worker\'s name, first and last (or preferred and last). Case does not matter. Unknown or shared names can be matched in the preview.', example: 'Marcus Reyes' },
  { key: 'site', required: false, accepts: 'The site they worked, by name, from the Reference sheet. Blank keeps an existing assignment\'s site.', example: 'Example DC West' },
  { key: 'role', required: false, accepts: 'The role they performed: lead, tech, cabling, logistics, or other (name or key). Blank keeps an existing assignment\'s role.', example: 'lead' },
];

export const TEAM_BULK_ERRORS: Record<string, string> = {
  unknown_columns: 'The file has columns that are not in the template (worker, site, role).',
  too_many_rows: 'Too many rows — the limit is 1,000 per upload.',
  file_too_large: 'File too large — the limit is 5 MB.',
  invalid_json: 'The server could not read the rows — preview again.',
  invalid_csv: 'That CSV could not be read.',
  invalid_xlsx: 'That spreadsheet could not be read.',
  unsupported_file: 'Unsupported file type — use .csv or .xlsx.',
  missing_file: 'Choose a file first.',
  invalid_row_numbers: 'The preview is out of date — upload the file again.',
  invalid_overrides: 'The preview is out of date — upload the file again.',
  invalid_skip: 'The preview is out of date — upload the file again.',
  invalid_approved: 'The preview is out of date — upload the file again.',
  rows_invalid: 'Some rows still need attention — resolve or skip them and try again.',
  initiative_archived: 'That job is archived — unarchive it first.',
  initiative_not_found: 'That job no longer exists.',
  forbidden: 'You do not have permission to bulk assign people.',
};

export function jobOptionLabel(job: InitiativeItem): string {
  return job.name;
}

/** Type · client · start date — enough to tell two same-named jobs apart. */
export function jobOptionDetail(job: Pick<InitiativeItem, 'type_label' | 'client_name' | 'scheduled_start'>): string {
  return [job.type_label, job.client_name, job.scheduled_start ? longDateOf(parseApiDay(job.scheduled_start)) : null]
    .filter(Boolean).join(' · ');
}
