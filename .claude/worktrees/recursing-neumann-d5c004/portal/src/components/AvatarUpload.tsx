/**
 * AvatarUpload — the global "click to add/change an image" flow.
 * Renders the entity's image (or gradient initials fallback); when
 * editable, clicking opens a file picker, validates, uploads through
 * the attachments API, and reports the new attachment to the caller.
 * Reused anywhere an image attaches to a record.
 */

import { useRef, useState } from 'react';

import { uploadAttachmentRequest, type AttachmentOut } from '../lib/api';
import { avatarGradient, initials } from '../lib/format';
import ImageCropModal from './ImageCropModal';
import '../styles/avatar-upload.css';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_BYTES = 5 * 1024 * 1024;

interface Props {
  name: string;
  url: string | null;
  entityType: 'person' | 'client' | 'partner';
  entityId: string;
  editable?: boolean;
  size?: number;          // px
  radius?: number;        // px
  onUploaded?: (attachment: AttachmentOut) => void;
}

export default function AvatarUpload({
  name, url, entityType, entityId,
  editable = false, size = 104, radius = 26, onUploaded,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cropFile, setCropFile] = useState<File | null>(null);

  const pick = () => {
    if (!editable || busy) return;
    setError('');
    inputRef.current?.click();
  };

  // file picked → open the crop/reposition dialog
  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      setError('Use a JPEG, PNG, WebP, or GIF image.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('Image is over 5 MB.');
      return;
    }
    setCropFile(file);
    if (inputRef.current) inputRef.current.value = '';
  };

  // crop confirmed → upload the cropped square
  const onCropped = async (blob: Blob) => {
    setCropFile(null);
    setBusy(true);
    try {
      const attachment = await uploadAttachmentRequest({
        entityType, entityId, kind: 'avatar',
        file: new File([blob], 'avatar.jpg', { type: 'image/jpeg' }),
      });
      onUploaded?.(attachment);
    } catch {
      setError('Upload failed — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="avatar-up-wrap">
      <button
        type="button"
        className={`avatar-up ${editable ? 'editable' : ''}`}
        style={{
          width: size, height: size, borderRadius: radius,
          fontSize: size * 0.33,
          background: url ? 'var(--surface-2, #f5f7fa)' : avatarGradient(name),
        }}
        onClick={pick}
        disabled={!editable || busy}
        aria-label={url ? 'Change photo' : 'Add photo'}
        title={editable ? (url ? 'Change photo' : 'Add photo') : undefined}
      >
        {url
          ? <img src={url} alt={name} />
          : <span className="avatar-ini">{initials(name)}</span>}
        {editable && !busy && (
          <span className="avatar-hover">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            {url ? 'Change' : 'Add photo'}
          </span>
        )}
        {busy && <span className="avatar-busy" />}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED.join(',')}
        style={{ display: 'none' }}
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      {error && <p className="avatar-error">{error}</p>}
      {cropFile && (
        <ImageCropModal
          file={cropFile}
          round
          onCancel={() => setCropFile(null)}
          onSave={(blob) => void onCropped(blob)}
        />
      )}
    </div>
  );
}
