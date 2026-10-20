/**
 * A static image's picture (spec 2026-10-20-badge-templates §4.3, §4.11):
 * a pick from the label image library (GET /labels/images), names in
 * natural order with each picture's size, and Upload… (POST /labels/images:
 * PNG, JPEG, WebP or GIF, 5 MB at most, kept as uploaded), which adds the
 * picture and picks it. A design holds the picture by its id; one deleted
 * from the library since prints nothing, and the picker says so.
 *
 * Delete… takes the picked picture out of the library (DELETE
 * /labels/images/{id}, a soft delete; allowed while templates use it)
 * after a confirm with the report-generate header. The element keeps the
 * id, so it prints nothing there until another picture is picked; the
 * canvas forgets the picture (imageRaster.ts forgetStaticRaster) and shows
 * its placeholder. `onDialog` tells the page while the confirm is open, so
 * the canvas keys stay off.
 */

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

import {
  ApiError, deleteLabelImage, listLabelImages, uploadLabelImage, type LabelImage,
} from '../../../lib/api';
import { naturalCompare } from '../../../lib/naturalSort';
import ComboBox from '../../ComboBox';
import '../../../styles/directory.css';   /* .btn-danger */
import '../../../styles/profile.css';     /* .btn-solid, .pf-error */
import '../../../styles/reports.css';     /* the report-generate header */
import '../../../styles/labelBuilder.css';
import { forgetStaticRaster } from './imageRaster';

/** The upload cap the API enforces (5 MiB). */
const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

function byName(rows: LabelImage[]): LabelImage[] {
  return [...rows].sort((a, b) => naturalCompare(a.name, b.name));
}

function uploadError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 413) return 'That file is over 5 MB.';
    if (err.status === 415 || err.status === 422) {
      return 'That file isn’t a picture a label can use: a PNG, JPEG, WebP or GIF of 40 megapixels at most.';
    }
    if (err.status === 403) return 'You don’t have access to the label image library.';
  }
  return 'Couldn’t upload the picture. Try again in a moment.';
}

function deleteError(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return 'You don’t have access to the label image library.';
  return 'Couldn’t delete the picture. Try again in a moment.';
}

/** Delete…'s confirm: the report-generate header, sized to its content. */
function DeleteImageDialog({ image, onDeleted, onClose }: {
  image: LabelImage;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const destroy = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteLabelImage(image.id);
    } catch (err) {
      // already gone: that's what was asked for
      if (!(err instanceof ApiError && err.status === 404)) {
        setError(deleteError(err));
        setBusy(false);
        return;
      }
    }
    onDeleted();
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card lbb-small-card" role="dialog" aria-modal="true"
        aria-label="Delete library image">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">{image.name} · Delete</div>
            <h3>Delete “{image.name}”?</h3>
            <p className="page-hint">Templates that use it will print nothing in its place until another image is picked.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid btn-danger" disabled={busy} onClick={() => void destroy()}>
            {busy ? 'Deleting…' : 'Delete image'}
          </button>
          <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </div>
      </div>
    </div>
  );
}

export default function ImageLibraryPicker({ value, onPick, disabled = false, onDialog }: {
  /** The picked picture's id, or null for none yet. */
  value: string | null;
  onPick: (imageId: string) => void;
  disabled?: boolean;
  /** Delete…'s confirm opened (true) or closed (false). */
  onDialog?: (open: boolean) => void;
}) {
  const [library, setLibrary] = useState<LabelImage[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<LabelImage | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    listLabelImages()
      .then((rows) => { if (live.current) setLibrary(byName(rows)); })
      .catch(() => { if (live.current) setLoadFailed(true); });
    return () => { live.current = false; };
  }, []);

  // the page hears while the confirm is open, and that it closed when the
  // picker goes away with it open
  const dialogOpen = deleting !== null;
  const tell = useRef(onDialog);
  tell.current = onDialog;
  useEffect(() => {
    if (!dialogOpen) return undefined;
    tell.current?.(true);
    return () => tell.current?.(false);
  }, [dialogOpen]);

  /** The picture is out of the library: off the list at once, then the
   *  library as the server has it now. */
  const deleted = (gone: LabelImage) => {
    forgetStaticRaster(gone.id);
    setLibrary((rows) => (rows ?? []).filter((r) => r.id !== gone.id));
    setDeleting(null);
    listLabelImages()
      .then((rows) => { if (live.current) setLibrary(byName(rows)); })
      .catch(() => {});
  };

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    if (file.size > MAX_BYTES) {
      setError('That file is over 5 MB.');
      return;
    }
    setUploading(true);
    try {
      const made = await uploadLabelImage(file);
      setLibrary((rows) => byName([...(rows ?? []).filter((r) => r.id !== made.id), made]));
      onPick(made.id);
    } catch (err) {
      setError(uploadError(err));
    } finally {
      setUploading(false);
    }
  };

  const options = (library ?? []).map((r) => ({ value: r.id, label: r.name, sub: `${r.width} × ${r.height}` }));
  const missing = !!value && library !== null && !library.some((r) => r.id === value);
  const picked = value ? library?.find((r) => r.id === value) ?? null : null;

  return (
    <>
      <div className="lbp-image-pick">
        <ComboBox portal ariaLabel="Static image" options={options} value={value ?? ''} disabled={disabled}
          placeholder={library === null && !loadFailed ? 'Loading…' : 'Pick a picture…'}
          onChange={(id) => { if (id) onPick(id); }} />
        <button type="button" className="mini-btn" disabled={disabled || uploading}
          onClick={() => fileRef.current?.click()}>
          {uploading ? 'Uploading…' : 'Upload…'}
        </button>
        {picked && (
          <button type="button" className="mini-btn" disabled={disabled}
            title="Delete this picture from the label image library" onClick={() => setDeleting(picked)}>
            Delete…
          </button>
        )}
        <input ref={fileRef} type="file" accept={ACCEPT} aria-label="Image file" hidden disabled={disabled}
          onChange={(e) => { void upload(e); }} />
      </div>
      {loadFailed && <div className="lbp-hint is-warning" role="status">Couldn’t load the label image library.</div>}
      {missing && (
        <div className="lbp-hint is-warning" role="status">
          This picture was deleted from the library, so it prints nothing. Pick another.
        </div>
      )}
      {error && <div className="lbp-hint is-warning" role="alert">{error}</div>}
      {deleting && (
        <DeleteImageDialog image={deleting} onDeleted={() => deleted(deleting)} onClose={() => setDeleting(null)} />
      )}
    </>
  );
}
