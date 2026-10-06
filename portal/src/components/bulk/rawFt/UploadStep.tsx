/**
 * UploadStep — step 1 of Convert Raw F-T: the drop zone, the Sheet and
 * Header row controls once a file is read, the template downloads and the
 * collapsed guide to our template's columns.
 */
import { useState } from 'react';

import { downloadMoveAssetTemplate, type MoveAssetTemplateColumn } from '../../../lib/api';
import CollapsePanel from '../../CollapsePanel';
import ComboBox from '../../ComboBox';
import DataTable from '../../DataTable';
import FileDropzone from '../../FileDropzone';
import type { useRawFtConvert } from './useRawFtConvert';

export default function UploadStep({ convert, template }: {
  convert: ReturnType<typeof useRawFtConvert>;
  template: MoveAssetTemplateColumn[];
}) {
  const { file, busy, error, sheets, sheet, sheetName, headerText, rows, inputRef } = convert;
  const [busyKey, setBusyKey] = useState('');
  const [downloadError, setDownloadError] = useState('');

  const downloadTemplate = async (key: 'xlsx' | 'csv') => {
    setBusyKey(key);
    setDownloadError('');
    try { await downloadMoveAssetTemplate(key); } catch { setDownloadError('Download failed — try again.'); } finally { setBusyKey(''); }
  };

  return (
    <div className="bulk-import ftc-pane">
      <FileDropzone file={file} onFile={(f) => void convert.onFile(f)} busy={busy} inputRef={inputRef} />
      {busy && <p className="page-hint">Reading the file…</p>}
      {error && <p className="pf-error">{error}</p>}

      {sheet && (
        <div className="pf-form ftc-setup">
          {sheets.length > 1 && (
            <div>
              <label htmlFor="ftc-sheet">Sheet</label>
              <ComboBox inputId="ftc-sheet" ariaLabel="Sheet" value={sheetName} onChange={convert.pickSheet}
                        options={sheets.map((s) => ({ value: s.name, label: s.name }))} />
            </div>
          )}
          <div>
            <label htmlFor="ftc-header-row">Header row</label>
            <input id="ftc-header-row" type="number" min={1} max={rows.length} value={headerText}
                   onChange={(e) => convert.changeHeaderRow(e.target.value)}
                   onBlur={convert.blurHeaderRow} />
          </div>
        </div>
      )}

      <div className="bulk-actions">
        <button type="button" className="mini-btn" disabled={!!busyKey} onClick={() => void downloadTemplate('xlsx')}>
          Template (.xlsx)
        </button>
        <button type="button" className="mini-btn" disabled={!!busyKey} onClick={() => void downloadTemplate('csv')}>
          Template (.csv)
        </button>
        {downloadError && <span className="pf-error">{downloadError}</span>}
      </div>
      <p className="set-note">The converted file is built in your browser. The From-To import accepts files up to 20 MB.</p>

      <CollapsePanel title="Our template columns" badge={<span className="badge-count">{template.length}</span>}>
        <DataTable
          ariaLabel="Template columns"
          columns={[
            { key: 'key', label: 'Column', mono: true },
            { key: 'required', label: 'Required' },
            { key: 'accepts', label: 'Accepts' },
            { key: 'example', label: 'Example', mono: true },
          ]}
          rows={template.map((c) => ({
            key: c.header, cells: [c.header, c.required ? 'Yes' : '', c.accepts, c.example || '—'],
          }))}
        />
      </CollapsePanel>
    </div>
  );
}
