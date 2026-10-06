/**
 * DownloadStep — step 3 of Convert Raw F-T: the converted preview, the
 * counts, and Start over. The Download button lives in the page's footer.
 */
import DataTable from '../../DataTable';
import type { useRawFtConvert } from './useRawFtConvert';

const PREVIEW_ROWS = 10;

export default function DownloadStep({ convert, onStartOver }: {
  convert: ReturnType<typeof useRawFtConvert>;
  /** Called after the conversion is cleared; the page uses it to go back to step 1. */
  onStartOver?: () => void;
}) {
  const { conversion, previewColumns } = convert;
  if (!conversion) return null;
  return (
    <div className="bulk-import ftc-pane">
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
        <button type="button" className="mini-btn" onClick={() => { convert.reset(); onStartOver?.(); }}>
          Start over
        </button>
      </div>
      <p className="set-note">Import it from a move's Import assets page or in Create a move in steps.</p>
    </div>
  );
}
