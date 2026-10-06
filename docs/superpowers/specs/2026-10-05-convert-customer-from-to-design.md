# Convert a customer From-To — design

Date: 2026-10-05. Branch `ft-convert`. Tracker: Gaps row 17 / Feature Parity
row 306 "Spreadsheet reformatting tool"; To-Do #39 (Bulk Actions hub) gains
the card. V2 equivalent: `portal-v4/src/pages/ProcessRawFT.jsx` ("Process Raw FT").

## Goal

A customer sends a From-To spreadsheet in their own layout. This Bulk
Actions tool maps its columns onto our From-To template and downloads a
converted .xlsx that goes straight into the From-To import (a move's
Import assets page, or Create a move in steps).

## Decisions

- **Name / card:** title **Convert a customer From-To**; description
  **Upload a customer's From-To, match its columns to ours, and download a
  sheet ready for the From-To import.**; button **Open**; route
  `/bulk/from-to-convert`; card and route gated like the From-To import:
  resource `initiatives`, action `change` (route `ProtectedRoute
  resource="initiatives" minRank={ADMIN_RANK}`).
- **Nothing is uploaded or saved.** The customer file is read in the
  browser with the portal's existing `xlsx` (SheetJS) library, as V2 did.
- **Target columns come from the server** so they never drift from the
  import: `GET /initiatives/assets/import-template?format=json` (same
  permission as the existing template download: `initiatives:change` +
  global scope) returns, in template order, each column's header, field,
  the import's own header aliases, required flag, a one-line "accepts"
  description, and the sample example value.
- **No file splitting** (V2 split at 4,500 rows; the V3 import takes the
  whole file, 20 MB limit).
- **No apply summary.** Nothing changes in the database, so the
  bulk-summary rule is met by the conversion preview plus counts; the
  converted file is the result.

## Page layout (same shell as sites / workers / trucks: `BulkToolPage`)

- Title **Convert a customer From-To**. Hint: **Upload a customer's
  From-To in their own layout, match each of their columns to one of ours,
  and download a file in our template's layout. The file is read in this
  browser and never uploaded. Then import it from a move's Import assets
  page or in Create a move in steps.**
- **Columns** section: our template columns from the server (Column,
  Required, Accepts, Example).
- **Download** section: **Template (.xlsx)** and **Template (.csv)** (the
  existing From-To template downloads). Limit note: **The converted file
  is built in your browser. The From-To import accepts files up to 20 MB.**
- **Upload** section, the tool's pane, three steps in order:
  1. **File:** the same drag-and-drop zone the From-To import uses
     (extracted into a shared `FileDropzone`), accepting .csv, .xlsx and
     .xls. Once read: a **Sheet** ComboBox (shown only when the workbook
     has more than one sheet with data; defaults to the first sheet with
     data) and a **Header row** number input (defaults to the detected
     row, 1-based).
  2. **Match columns:** a DataTable with one row per customer column:
     **Their column** (header text), **Sample values** (up to three
     distinct non-blank values, joined by " · "), **Our column** (portaled
     ComboBox, type to filter, first option **Skip**). Pre-filled
     suggestions show a **Suggested** chip until changed. A target column
     already picked by another row is not offered in any other row. Above
     the table: **{n} of {m} columns matched** and a **Clear all** /
     **Use suggestions** pair of mini buttons. If Serial Number is not
     matched, a note: **Serial Number isn't matched. Turn on Generate
     serials when you import, or the rows will be rejected.**
  3. **Preview and download:** a DataTable of the first 10 converted rows,
     showing only the matched target columns in template order; the line
     **{rows} rows converted · {blank} blank rows dropped · {ignored} of
     their columns ignored**; and the solid button **Download converted
     file**, disabled until at least one column is matched. It saves
     `<customer file base name>-converted.xlsx` with one sheet named
     **Move Assets**: row 1 is every template header in template order,
     then one row per non-blank data row, unmatched columns blank.

## Reading the file

- Read with `XLSX.read(buffer, { type: 'array', cellNF: true, raw: true })` (`raw` keeps CSV text such as `00123` as typed).
- Cell → text: blank/null → `''`; a number cell whose number format is a date → `YYYY-MM-DD` via `XLSX.SSF.parse_date_code` (no time zone involved); a number →
  `String(v)` (integers print without `.0`; never the formatted text, which
  turns long serials into `1.2E+11`); a boolean → `TRUE`/`FALSE`; a string →
  trimmed.
- A sheet "has data" when any cell is non-blank.
- **Header row detection:** the first row (within the first 20) with at
  least two non-blank cells; else row 1.
- **Customer columns:** every column index from the header row's first to
  last used cell across the sheet. Header text = the header cell's text; a
  blank header cell whose column has data below becomes **Column {letter}**;
  a blank header with no data below is dropped. Duplicate header texts (compared ignoring case) get
  ` (2)`, ` (3)`… in order.
- **Data rows:** every row after the header row; a row whose customer
  columns are all blank is dropped and counted as a blank row.

## Suggestions

`normalize(s)`: lowercase; every run of non-alphanumeric characters becomes
one space; trim. Tokens = normalized split on spaces.

1. **Exact (strongest):** normalize(customer header) equals normalize of a
   template header or of one of its aliases.
2. **Keyword rules**, first matching rule wins, evaluated on the tokens:

| Rule | Tokens contain | Target field |
|---|---|---|
| vendor involvement | `vendor` and (`involvement` or `involved`) | vendor_involvement |
| serial | `serial`, or `sn`, or the pair `s` `n` adjacent, or `service` + `tag` | serial_number |
| rfid | `rfid` or `epc` | rfid_tag |
| model | `model` | asset_model |
| make | `make`, `manufacturer`, `mfr`, `mfg`, `brand`, or `vendor` | asset_make |
| data n | `data` + a token `1`–`6` | data_n |
| mgmt n | `mgmt` or `management`, + `1` or `2` | mgmt_n |
| ru | `ru`, `u`, `elevation`, or (`rack` and `position`) | {side}_ru |
| position | `position`, `orientation`, `face`, or `side` | {side}_position |
| rack | `rack`, `cabinet`, or `cab` | {side}_rack |
| pod | `pod` | {side}_pod |
| name | `hostname`, `host`, or `name` | asset_name |
| priority | `priority` or `wave` | priority |
| disposition | `disposition` | disposition |
| owner | `owner` | owner |

   The name rule sits below rack and pod so "Rack Name" stays a rack.
   `{side}` is `destination` when the tokens contain any of `to`, `dest`,
   `destination`, `dst`, `new`, `target`; otherwise `source` (matching the
   import's rule that a lone Pod column is the source pod).
3. **Assignment:** all exact matches first, then keyword matches, each pass
   in customer-column order; a match is skipped when its target is already
   taken or its customer column already has one. Everything else is Skip.

## Testing

- API: `format=json` returns 25 columns in template order with the
  expected first entry (Serial Number, field serial_number, aliases include
  "serial number", required true, example "SN-0001"); view-only users get
  403; unknown formats still 422.
- Portal lib (pure, vitest): cell text rules; header detection; blank and
  duplicate headers; blank-row dropping; every suggestion rule incl.
  side words, exact-beats-keyword, and one-target-per-column; conversion
  output layout; filename.
- Portal page: suggestions pre-filled; a taken column is missing from other
  dropdowns; Skip frees it; Serial note; preview counts; download builds the
  expected workbook (mock `XLSX.writeFile`); the card shows only with
  initiatives:change; the From-To import's drop zone still works after the
  extraction.
