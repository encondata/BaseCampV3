/**
 * useRawFtConvert — the state and logic behind Convert Raw F-T: read a
 * customer's workbook in this browser, suggest and edit the matches from
 * their columns to our From-To template columns, convert, and download.
 * Nothing is uploaded or stored.
 * Spec: docs/superpowers/specs/2026-10-06-convert-raw-ft-steps-design.md
 */
import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';

import type { MoveAssetTemplateColumn } from '../../../lib/api';
import {
  convertRows, convertedFilename, convertedWorkbook, detectHeaderRow, readWorkbook, sheetHasData,
  sourceColumns, suggestMapping, type ColumnMapping, type SheetData,
} from '../../../lib/ftConvert';

export function useRawFtConvert(template: MoveAssetTemplateColumn[]) {
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

  const blurHeaderRow = () => setHeaderText(String(headerRow));

  const setTarget = (index: number, header: string) =>
    setMapping((prev) => {
      const next = { ...prev };
      if (header) next[index] = header; else delete next[index];
      return next;
    });

  const clearAll = () => setMapping({});
  const useSuggestions = () => setMapping({ ...suggested });

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

  /** Start over: drop the file and everything read from it (and the input's DOM value). */
  const reset = () => {
    void onFile(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  return {
    file, busy, error, sheets, sheet, sheetName, headerRow, headerText, rows, columns, mapping, suggested,
    conversion, matched, serialMatched, usedHeaders, previewColumns, inputRef,
    onFile, pickSheet, changeHeaderRow, blurHeaderRow, setTarget, clearAll, useSuggestions, download, reset,
  };
}
