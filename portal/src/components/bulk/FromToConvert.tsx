/**
 * FromToConvert — temporary composition of Convert Raw F-T's hook and step
 * components in one pane (Upload, Match, Download in order). The three-step
 * wizard page (pages/BulkConvertRawFt.tsx) replaces this and the page that
 * renders it.
 * Spec: docs/superpowers/specs/2026-10-06-convert-raw-ft-steps-design.md
 */
import type { MoveAssetTemplateColumn } from '../../lib/api';
import DownloadStep from './rawFt/DownloadStep';
import MatchStep from './rawFt/MatchStep';
import UploadStep from './rawFt/UploadStep';
import { useRawFtConvert } from './rawFt/useRawFtConvert';

export default function FromToConvert({ columns: template }: { columns: MoveAssetTemplateColumn[] }) {
  const convert = useRawFtConvert(template);
  return (
    <div className="bulk-import ftc-pane">
      <UploadStep convert={convert} template={template} />
      {convert.sheet && convert.conversion && (
        <>
          <p className="imp-options-sublabel">Match columns</p>
          <MatchStep convert={convert} template={template} />
          <p className="imp-options-sublabel">Preview and download</p>
          <DownloadStep convert={convert} />
          <div className="bulk-actions">
            <button type="button" className="btn-solid" disabled={convert.matched === 0} onClick={convert.download}>
              Download converted file
            </button>
          </div>
        </>
      )}
    </div>
  );
}
