/**
 * MatchStep — step 2 of Convert Raw F-T: match each of the customer's
 * columns to one of our From-To template columns (suggestions filled in).
 */
import type { MoveAssetTemplateColumn } from '../../../lib/api';
import ComboBox from '../../ComboBox';
import DataTable from '../../DataTable';
import type { useRawFtConvert } from './useRawFtConvert';

const NO_SERIAL = "Serial Number isn't matched. Turn on Generate serials when you import, or the rows will be rejected.";

export default function MatchStep({ convert, template }: {
  convert: ReturnType<typeof useRawFtConvert>;
  template: MoveAssetTemplateColumn[];
}) {
  const { columns, mapping, suggested, matched, serialMatched, usedHeaders } = convert;
  return (
    <div className="bulk-import ftc-pane">
      <div className="bulk-actions">
        <p className="set-note">{`${matched} of ${columns.length} columns matched`}</p>
        <button type="button" className="mini-btn" onClick={convert.clearAll}>Clear all</button>
        <button type="button" className="mini-btn" onClick={convert.useSuggestions}>Use suggestions</button>
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
                onChange={(v) => convert.setTarget(col.index, v)}
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
    </div>
  );
}
