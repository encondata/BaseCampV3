/**
 * The printer-rendered preview (spec §4.7): the canvas is the preview, and
 * this is the check — the design compiled with its sample values at the
 * DPI shown (POST /labels/templates/compile), rendered by Labelary with the
 * open fonts it prints with embedded (POST /labels/preview/zpl, font_ids).
 * The resident Swiss cut renders as the printer's font 0, the same face.
 * It renders when asked: Labelary is an outside service.
 */

import { useEffect, useState } from 'react';

import type { DesignV2 } from '../../../labels/builder/model';
import { fontIdsFor, previewRequest } from '../../../labels/builder/zplPreview';
import { ApiError, compileLabel, previewZplRequest, type LabelFont } from '../../../lib/api';
import '../../../styles/directory.css';
import '../../../styles/labelBuilder.css';

export interface PreviewPanelProps {
  design: DesignV2;
  dpi: number;
  samples: Readonly<Record<string, string>>;
  /** GET /labels/fonts; null while it loads. */
  library: readonly LabelFont[] | null;
  sizeKey: string;
  /** The template's label type: the preview mocks only its fields. */
  labelType: string;
  /** Only ZPL renders here. */
  disabled?: boolean;
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'labelary_unavailable') return 'The preview service is not answering. Try again in a moment.';
    if (err.code === 'bad_design') {
      const problems = (err.detail as { problems?: string[] } | undefined)?.problems;
      return problems?.length ? `The design can't print yet: ${problems[0]}` : "The design can't print yet.";
    }
  }
  return "Couldn't render the preview.";
}

export default function PreviewPanel({
  design, dpi, samples, library, sizeKey, labelType, disabled = false,
}: PreviewPanelProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [shown, setShown] = useState<{ design: DesignV2; dpi: number; samples: Readonly<Record<string, string>> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // the object URL goes when it is replaced or the panel leaves
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const render = async () => {
    setBusy(true);
    setError(null);
    try {
      const req = previewRequest(design, dpi, samples, fontIdsFor(design, library ?? []), sizeKey, labelType);
      const { code } = await compileLabel(req.compile);
      const blob = await previewZplRequest(req.preview(code));
      setUrl(URL.createObjectURL(blob));
      setShown({ design, dpi, samples });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const stale = shown !== null && (shown.design !== design || shown.dpi !== dpi || shown.samples !== samples);

  return (
    <section className="lbp lbb-preview" aria-label="Printer preview">
      <div className="lbp-title">
        Printer preview
        <span className="lbp-hint">{dpi} DPI</span>
      </div>
      <div className="lbb-preview-body">
        {url && <img className="lbb-preview-img" alt="The label as the printer renders it" src={url} />}
        {stale && <p className="lbp-hint">Changed since this render.</p>}
        {!url && !error && (
          <p className="lbp-hint">The label as a Zebra printer renders it, with the sample values.</p>
        )}
        {error && <p className="pf-error" role="alert">{error}</p>}
        <button type="button" className="mini-btn" disabled={busy || disabled} onClick={() => void render()}>
          {busy ? 'Rendering…' : url ? 'Render again' : 'Render'}
        </button>
      </div>
    </section>
  );
}
