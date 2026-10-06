/**
 * FromToConvert — the Upload pane of Bulk Actions › Convert a customer
 * From-To (/bulk/from-to-convert): read a customer's workbook in this
 * browser, match each of their columns to one of our From-To template
 * columns (with suggestions), preview, and download a file in our
 * template's layout. Nothing is uploaded or stored.
 * Spec: docs/superpowers/specs/2026-10-05-convert-customer-from-to-design.md
 */
import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';

import type { MoveAssetTemplateColumn } from '../../lib/api';
import {
  convertRows, convertedFilename, convertedWorkbook, detectHeaderRow, readWorkbook, sheetHasData,
  sourceColumns, suggestMapping, type ColumnMapping, type SheetData,
} from '../../lib/ftConvert';
import ComboBox from '../ComboBox';
import DataTable from '../DataTable';
import FileDropzone from '../FileDropzone';

const PREVIEW_ROWS = 10;
const NO_SERIAL = "Serial Number isn't matched. Turn on Generate serials when you import, or the rows will be rejected.";

export default function FromToConvert({ columns: template }: { columns: MoveAssetTemplateColumn[] }) {
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [sheetName, setSheetName] = useState('');
  const [headerRow, setHeaderRow] = useState(1);              // 1-based, as the person counts
  const [headerText, setHeaderText] = useState('1');          // what the input shows while typing
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [suggested, setSuggested] = useState<ColumnMapping>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);                     // a file is being read and parsed
  const inputRef = useRef<HTMLInputElement | null>(null);
  const readToken = useRef(0);

  const sheet = sheets.find((s) => s.name === sheetName) ?? null;
  const rows = sheet?.rows ?? [];
  const headerIndex = headerRow - 1;
  const columns = useMemo(() => (sheet ? sourceColumns(rows, headerIndex) : []),
    [sheet, rows, headerIndex]);
  const conversion = useMemo(() => (sheet ? convertRows(rows, headerIndex, columns, mapping, template) : null),
    [sheet, rows, headerIndex, columns, mapping, template]);

  /** (Re)read the columns of a sheet at a header row and reset the matches to the suggestions. */
  const loadSheet = (s: SheetData, row: number) => {
    const suggestions = suggestMapping(sourceColumns(s.rows, row - 1), template);
    setSheetName(s.name);
    setHeaderRow(row);
    setHeaderText(String(row));
    setMapping(suggestions);
    setSuggested(suggestions);
  };

  const onFile = async (f: File | null) => {
    const token = ++readToken.current;
    setFile(f);
    setError('');
    setSheets([]);
    setSheetName('');
    setMapping({});
    setSuggested({});
    setBusy(!!f);
    if (!f) return;
    let read: SheetData[];
    try {
      const buffer = await f.arrayBuffer();
      await new Promise((r) => setTimeout(r, 0));             // let "Reading the file…" paint before the parse blocks
      if (token !== readToken.current) return;                // a newer file replaced this one
      read = readWorkbook(buffer);
    } catch {
      if (token === readToken.current) { setError('That file could not be read.'); setBusy(false); }
      return;
    }
    if (token !== readToken.current) return;
    setBusy(false);
    const withData = read.filter(sheetHasData);
    if (!withData.length) { setError('That file has no data.'); return; }
    setSheets(withData);
    loadSheet(withData[0], detectHeaderRow(withData[0].rows) + 1);
  };

  const pickSheet = (name: string) => {
    const s = sheets.find((x) => x.name === name);
    if (s) loadSheet(s, detectHeaderRow(s.rows) + 1);
  };

  const changeHeaderRow = (text: string) => {
    setHeaderText(text);
    const n = Number.parseInt(text, 10);
    if (!sheet || Number.isNaN(n)) return;
    loadSheet(sheet, Math.min(Math.max(n, 1), Math.max(rows.length, 1)));
    setHeaderText(text);                                      // keep what they typed until blur
  };

  const setTarget = (index: number, header: string) =>
    setMapping((prev) => {
      const next = { ...prev };
      if (header) next[index] = header; else delete next[index];
      return next;
    });

  const matched = columns.filter((c) => mapping[c.index]).length;
  const serialHeader = template.find((t) => t.field === 'serial_number')?.header;
  const serialMatched = !!serialHeader && Object.values(mapping).includes(serialHeader);
  const usedHeaders = new Set(Object.values(mapping).filter(Boolean));
  const previewColumns = template
    .map((t, position) => ({ t, position }))
    .filter(({ t }) => columns.some((c) => mapping[c.index] === t.header));

  const download = () => {
    if (!file || !conversion) return;
    XLSX.writeFile(convertedWorkbook(conversion), convertedFilename(file.name), { compression: true });
  };

  return (
    <div className="bulk-import ftc-pane">
      <FileDropzone file={file} onFile={(f) => void onFile(f)} busy={busy} inputRef={inputRef} />
      {busy && <p className="page-hint">Reading the file…</p>}
      {error && <p className="pf-error">{error}</p>}

      {sheet && conversion && (
        <>
          <div className="pf-form ftc-setup">
            {sheets.length > 1 && (
              <div>
                <label htmlFor="ftc-sheet">Sheet</label>
                <ComboBox inputId="ftc-sheet" ariaLabel="Sheet" value={sheetName} onChange={pickSheet}
                          options={sheets.map((s) => ({ value: s.name, label: s.name }))} />
              </div>
            )}
            <div>
              <label htmlFor="ftc-header-row">Header row</label>
              <input id="ftc-header-row" type="number" min={1} max={rows.length} value={headerText}
                     onChange={(e) => changeHeaderRow(e.target.value)}
                     onBlur={() => setHeaderText(String(headerRow))} />
            </div>
          </div>

          <p className="imp-options-sublabel">Match columns</p>
          <div className="bulk-actions">
            <p className="set-note">{`${matched} of ${columns.length} columns matched`}</p>
            <button type="button" className="mini-btn" onClick={() => setMapping({})}>Clear all</button>
            <button type="button" className="mini-btn" onClick={() => setMapping({ ...suggested })}>
              Use suggestions
            </button>
          </div>
          {!serialMatched && <p className="set-note">{NO_SERIAL}</p>}
          <DataTable
            ariaLabel="Column matches"
            columns={[
              { key: 'theirs', label: 'Their column' },
              { key: 'samples', label: 'Sample values' },
              { key: 'ours', label: 'Our column' },
            ]}
            rows={columns.map((col) => ({
              key: String(col.index),
              cells: [
                col.header,
                col.samples.join(' · ') || '—',
                <div className="ftc-target" key="t">
                  <ComboBox
                    portal
                    ariaLabel={`Our column for ${col.header}`}
                    value={mapping[col.index] ?? ''}
                    onChange={(v) => setTarget(col.index, v)}
                    options={[
                      { value: '', label: 'Skip' },
                      ...template
                        .filter((t) => t.header === mapping[col.index] || !usedHeaders.has(t.header))
                        .map((t) => ({ value: t.header, label: t.header })),
                    ]}
                  />
                  {mapping[col.index] && mapping[col.index] === suggested[col.index] && (
                    <span className="chip c-blue">Suggested</span>
                  )}
                </div>,
              ],
            }))}
          />

          <p className="imp-options-sublabel">Preview and download</p>
          <DataTable
            ariaLabel="Converted preview"
            columns={previewColumns.map(({ t }) => ({ key: t.field, label: t.header }))}
            rows={(previewColumns.length ? conversion.rows.slice(0, PREVIEW_ROWS) : []).map((r, i) => ({
              key: String(i),
              cells: previewColumns.map(({ position }) => r[position] || '—'),
            }))}
            emptyText="Match at least one column to see the converted rows."
          />
          <p className="set-note">
            {`${conversion.rows.length} rows converted · ${conversion.blankRows} blank rows dropped · ${conversion.ignoredColumns} of their columns ignored`}
          </p>
          <div className="bulk-actions">
            <button type="button" className="btn-solid" disabled={matched === 0} onClick={download}>
              Download converted file
            </button>
          </div>
        </>
      )}
    </div>
  );
}
