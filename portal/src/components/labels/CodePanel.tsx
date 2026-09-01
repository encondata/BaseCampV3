/**
 * Generated-code panel — Task 18. Collapsible section under the editor
 * body (design AND code kinds) showing a debounced (500 ms) sample
 * compile of the current design/code, plus — for ZPL templates only —
 * a "Printer preview" button that renders the compiled sample through
 * Labelary via `previewZplRequest`. Debounce guards against races with
 * a `cancelled` flag; the preview image's object URL is revoked before
 * every replacement and on unmount.
 */

import { useEffect, useState } from 'react';

import { ApiError, compileLabel, previewZplRequest } from '../../lib/api';
import type { LabelDesign } from '../../lib/labelModel';

interface Props {
  kind: 'design' | 'code';
  design: LabelDesign | null;
  codeText: string;
  sizeKey: string;
  dpiKey: string;
  languageKey: string;
}

export default function CodePanel({
  kind, design, codeText, sizeKey, dpiKey, languageKey,
}: Props) {
  const [open, setOpen] = useState(true);
  const [code, setCode] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void compileLabel({
        kind,
        design: kind === 'design' ? (design as unknown as Record<string, unknown>) : undefined,
        code: kind === 'code' ? codeText : undefined,
        size_key: sizeKey,
        dpi_key: dpiKey,
        language_key: languageKey,
        mode: 'sample',
      }).then((r) => {
        if (cancelled) return;
        setCode(r.code);
        setProblems([]);
      }).catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === 'bad_design') {
          setProblems((err.detail as { problems?: string[] } | undefined)?.problems
            ?? ['Invalid design.']);
        } else {
          setProblems(['Compile unavailable.']);
        }
      });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [kind, design, codeText, sizeKey, dpiKey, languageKey]);

  // Revoke the preview object URL on replace/unmount — nothing else owns it.
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const handlePreview = async () => {
    setPreviewError(false);
    try {
      const blob = await previewZplRequest({ zpl: code, size_key: sizeKey, dpi_key: dpiKey });
      // Revocation of the URL this replaces (or this one, on unmount) is
      // handled by the effect above, keyed off previewUrl.
      setPreviewUrl(URL.createObjectURL(blob));
    } catch {
      setPreviewError(true);
    }
  };

  return (
    <div className="lbl-code-panel">
      <button type="button" className="mini-btn" aria-expanded={open}
              onClick={() => setOpen((o) => !o)}>
        Generated code
      </button>
      {open && (
        <div className="lbl-code-panel-body">
          <pre className="mono lbl-code">{code}</pre>
          {problems.map((p) => <div key={p} className="pf-error">{p}</div>)}
          <div className="lbl-code-actions">
            {languageKey === 'zpl' && (
              <button type="button" className="mini-btn" onClick={() => void handlePreview()}>
                Printer preview
              </button>
            )}
          </div>
          {previewUrl && (
            <img className="lbl-preview-img" alt="Printer preview" src={previewUrl} />
          )}
          {previewError && <div className="pf-error">Printer preview unavailable.</div>}
        </div>
      )}
    </div>
  );
}
