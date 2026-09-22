/** What each bulk-import column accepts. Keys mirror the API's
 *  sites/bulk_import.py COLUMNS — the service test pins that list, the
 *  test beside this file pins this one, and the two must agree. */
export interface SiteColumnGuide { key: string; required: boolean; accepts: string; example: string }

export const SITE_COLUMN_GUIDE: SiteColumnGuide[] = [
  { key: 'name', required: true, accepts: 'Site name. Matches an existing site by name (case does not matter).', example: 'Example DC West' },
  { key: 'code', required: false, accepts: 'Short code, free text.', example: 'DCW' },
  { key: 'type', required: false, accepts: 'A site type key from the Reference sheet (datacenter, office, warehouse, …).', example: 'datacenter' },
  { key: 'status', required: false, accepts: 'A site status key from the Reference sheet. Blank means active for new sites.', example: 'active' },
  { key: 'address_line1', required: false, accepts: 'Street address. Also matches an existing site by address.', example: '100 Server Way' },
  { key: 'address_line2', required: false, accepts: 'Suite, floor, building.', example: '' },
  { key: 'city', required: false, accepts: 'Free text.', example: 'Reno' },
  { key: 'region', required: false, accepts: 'State or province.', example: 'NV' },
  { key: 'postal_code', required: false, accepts: 'Free text.', example: '89501' },
  { key: 'country', required: false, accepts: 'Two-letter code. Blank means US for new sites.', example: 'US' },
  { key: 'latitude', required: false, accepts: 'Decimal degrees, −90 to 90. Set with longitude or leave both blank.', example: '39.5296' },
  { key: 'longitude', required: false, accepts: 'Decimal degrees, −180 to 180.', example: '-119.8138' },
  { key: 'timezone', required: false, accepts: 'IANA zone name.', example: 'America/Los_Angeles' },
  { key: 'dc_provider', required: false, accepts: 'Free text.', example: 'Switch' },
  { key: 'partner', required: false, accepts: 'An existing partner name, exactly as listed.', example: '' },
  { key: 'clients', required: false, accepts: 'Existing client names separated by semicolons.', example: 'Acme Co; Globex' },
  { key: 'notes', required: false, accepts: 'Free text.', example: '' },
];

export const SITE_BULK_ERRORS: Record<string, string> = {
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
