/** The move-assets import's upload fields — the template links, the
 *  dropzone, and the make/model + serial-number options. Shared by the
 *  move import page and the Create-a-move-in-steps assets step. */
import type { MutableRefObject } from 'react';

import { downloadMoveAssetTemplate } from '../../lib/api';
import FileDropzone from '../FileDropzone';

/** make/model mode descriptions — verbatim intent from the template's
 *  Reference sheet (api/src/serversherpa/imports/parsing.py's
 *  build_template_xlsx), reworded here as a title + one-line description
 *  instead of one cramped all-caps pill label. */
export const MODE_OPTIONS: { value: string; title: string; desc: string }[] = [
  { value: 'fuzzy', title: 'Match only',
    desc: 'Unmatched make/models are flagged for review.' },
  { value: 'force', title: 'Always create',
    desc: 'Missing make/models are created automatically.' },
  { value: 'hybrid', title: 'Match, then create',
    desc: 'Try to match first; create when nothing matches.' },
];

export function ImportTemplateLinks({ busy }: { busy: boolean }) {
  return (
    <div className="imp-template-links">
      <span>Download template:</span>
      <button type="button" className="imp-link-btn" disabled={busy}
              onClick={() => void downloadMoveAssetTemplate('xlsx')}>
        .xlsx
      </button>
      <span>·</span>
      <button type="button" className="imp-link-btn" disabled={busy}
              onClick={() => void downloadMoveAssetTemplate('csv')}>
        .csv
      </button>
    </div>
  );
}

interface Props {
  file: File | null;
  onFile: (f: File | null) => void;
  mode: string;
  onMode: (m: string) => void;
  generateSerials: boolean;
  onGenerateSerials: (v: boolean) => void;
  busy: boolean;
  inputRef: MutableRefObject<HTMLInputElement | null>;
}

export default function ImportUploadFields({
  file, onFile, mode, onMode, generateSerials, onGenerateSerials, busy, inputRef,
}: Props) {
  return (
    <>
      <FileDropzone file={file} onFile={onFile} busy={busy} inputRef={inputRef} />

      <div className="imp-options">
        <p className="imp-options-label">Options</p>

        <div className="imp-options-group">
          <p className="imp-options-sublabel">Make / model matching</p>
          <p className="imp-options-explainer">
            How makes and models in your file are matched against the catalog.
          </p>
          <div className="imp-radio-group" role="radiogroup"
               aria-label="Make/model handling">
            {MODE_OPTIONS.map((opt) => (
              <label key={opt.value} className="imp-radio">
                <input type="radio" name="make-model-mode" value={opt.value}
                       checked={mode === opt.value} disabled={busy}
                       onChange={() => onMode(opt.value)} />
                <span className="imp-radio-body">
                  <span className="imp-radio-title">{opt.title}</span>
                  <span className="imp-radio-desc">{opt.desc}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="imp-options-group">
          <p className="imp-options-sublabel">Serial numbers</p>
          <label className="imp-checkbox">
            <input type="checkbox" checked={generateSerials} disabled={busy}
                   onChange={(e) => onGenerateSerials(e.target.checked)} />
            <span className="imp-radio-body">
              <span className="imp-radio-title">Generate serial numbers</span>
              <span className="imp-radio-desc">
                Rows with a blank serial number get one generated (gnrtd-xxxxxx), unique across every asset.
              </span>
            </span>
          </label>
        </div>
      </div>
    </>
  );
}
