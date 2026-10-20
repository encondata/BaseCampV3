/**
 * A static image's picture (spec 2026-10-20-badge-templates §4.3, §4.11):
 * a pick from the label image library (GET /labels/images), names in
 * natural order with each picture's size, and Upload… (POST /labels/images:
 * PNG, JPEG, WebP or GIF, 5 MB at most, kept as uploaded), which adds the
 * picture and picks it. A design holds the picture by its id; one deleted
 * from the library since prints nothing, and the picker says so.
 */

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

import { ApiError, listLabelImages, uploadLabelImage, type LabelImage } from '../../../lib/api';
import { naturalCompare } from '../../../lib/naturalSort';
import ComboBox from '../../ComboBox';

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

export default function ImageLibraryPicker({ value, onPick, disabled = false }: {
  /** The picked picture's id, or null for none yet. */
  value: string | null;
  onPick: (imageId: string) => void;
  disabled?: boolean;
}) {
  const [library, setLibrary] = useState<LabelImage[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    listLabelImages()
      .then((rows) => { if (live) setLibrary(byName(rows)); })
      .catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, []);

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
    </>
  );
}
