/** Upload a version: drop in an APK or IPA, which goes straight to the
 *  bucket through a presigned URL, then the devices API reads it and shows
 *  the review summary (the app, new or existing, version, build, signing
 *  certificate) with any problems. Save stores it with its release notes;
 *  it stays off while there are problems. */
import { useRef, useState } from 'react';

import FileDropzone from '@portal/components/FileDropzone';
import StandardModal from '@portal/components/StandardModal';
import '@portal/styles/initiatives.css';   // .imp-dropzone

import {
  commitUpload, createUpload, errorText, inspectUpload, PLATFORM_LABEL, putFile, type InspectOut,
} from '../lib/appsApi';

type Step =
  | { kind: 'pick' }
  | { kind: 'uploading'; progress: number }
  | { kind: 'checking' }
  | { kind: 'review'; uploadId: string; review: InspectOut }
  | { kind: 'saving'; uploadId: string; review: InspectOut };

export default function UploadModal({ onClose, onSaved }: {
  onClose: () => void;
  /** The version was saved (the host closes the modal and reloads). */
  onSaved: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busy = step.kind === 'uploading' || step.kind === 'checking' || step.kind === 'saving';

  const upload = async () => {
    if (!file) return;
    setError(null);
    setStep({ kind: 'uploading', progress: 0 });
    try {
      const target = await createUpload(file);
      await putFile(target, file, (progress) => setStep({ kind: 'uploading', progress }));
      setStep({ kind: 'checking' });
      const review = await inspectUpload(target.upload_id);
      setStep({ kind: 'review', uploadId: target.upload_id, review });
    } catch (err) {
      setError(errorText(err));
      setStep({ kind: 'pick' });
    }
  };

  const save = async () => {
    if (step.kind !== 'review' || step.review.problems.length) return;
    setError(null);
    setStep({ ...step, kind: 'saving' });
    try {
      await commitUpload(step.uploadId, notes);
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setStep({ ...step, kind: 'review' });
    }
  };

  const review = step.kind === 'review' || step.kind === 'saving' ? step.review : null;
  const footer = (
    <>
      <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
      {review ? (
        <button type="button" className="btn-solid" onClick={() => void save()}
                disabled={busy || review.problems.length > 0}>
          {step.kind === 'saving' ? 'Saving…' : 'Save'}
        </button>
      ) : (
        <button type="button" className="btn-solid" onClick={() => void upload()} disabled={!file || busy}>
          {step.kind === 'uploading' ? 'Uploading…' : step.kind === 'checking' ? 'Checking…' : 'Upload'}
        </button>
      )}
    </>
  );

  return (
    <StandardModal eyebrow="Devices" title="Upload a version" onClose={onClose} busy={busy}
                   cardClass="devices-modal" footer={footer}>
      {review ? (
        <Review review={review} notes={notes} onNotes={setNotes} busy={busy} />
      ) : (
        <>
          <FileDropzone file={file} onFile={setFile} busy={busy} inputRef={inputRef} accept=".apk,.ipa"
                        hint="An Android APK or an iOS IPA — .apk or .ipa" />
          {step.kind === 'uploading' && (
            <div className="devices-progress" role="progressbar" aria-label="Upload progress"
                 aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(step.progress * 100)}>
              <span style={{ width: `${Math.round(step.progress * 100)}%` }} />
            </div>
          )}
          {step.kind === 'checking' && <p className="page-hint">Checking the file…</p>}
        </>
      )}
      {error && <p className="pf-error devices-modal-error">{error}</p>}
    </StandardModal>
  );
}

function Review({ review, notes, onNotes, busy }: {
  review: InspectOut; notes: string; onNotes: (v: string) => void; busy: boolean;
}) {
  const { app } = review;
  return (
    <>
      <dl className="devices-review">
        <dt>App</dt>
        <dd>
          {app.exists ? app.name : <><span className="chip c-amber">New app</span> {app.name}</>}
          <span className="page-hint">{` · ${PLATFORM_LABEL[app.platform]} · `}<span className="mono">{app.identifier}</span></span>
        </dd>
        <dt>Version</dt>
        <dd className="mono">{review.version_name}</dd>
        <dt>Build</dt>
        <dd className="mono">{review.build}</dd>
        <dt>Signing certificate</dt>
        <dd className="mono">{review.signing_digest ? review.signing_digest.slice(0, 12) : '—'}</dd>
      </dl>
      {review.problems.map((problem) => <p key={problem} className="pf-error">{problem}</p>)}
      <div className="pf-form devices-form">
        <div className="full">
          <label htmlFor="devices-upload-notes">Release notes</label>
          <textarea id="devices-upload-notes" rows={4} value={notes} maxLength={5000} disabled={busy}
                    onChange={(e) => onNotes(e.target.value)} />
        </div>
      </div>
    </>
  );
}
