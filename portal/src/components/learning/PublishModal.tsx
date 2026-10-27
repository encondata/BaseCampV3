/**
 * Publish vN: snapshots the linked wiki page's current published version
 * (content and rendered HTML) as the document's next version. The "what
 * changed" note is optional and shows to workers who must sign again.
 */

import { useState } from 'react';

import { publishLearningDocument, type LearningVersion } from '../../lib/learning';
import { apiErrorText, PUBLISH_ERRORS } from '../../lib/learningDoc';
import LearningModal from './LearningModal';

export default function PublishModal({ documentId, title, versionNo, onClose, onPublished }: {
  documentId: string;
  title: string;
  /** The number the new version will get. */
  versionNo: number;
  onClose: () => void;
  onPublished: (version: LearningVersion) => void;
}) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const publish = async () => {
    setSaving(true);
    setError('');
    try {
      const trimmed = note.trim();
      onPublished(await publishLearningDocument(documentId, trimmed || undefined));
    } catch (e) {
      setError(apiErrorText(e, PUBLISH_ERRORS));
      setSaving(false);
    }
  };

  return (
    <LearningModal eyebrow={title} title={`Publish v${versionNo}`}
                   label={`Publish version ${versionNo}`}
                   description="Workers read this version from now on. People who signed an earlier version are asked to sign again when the rules say so."
                   onClose={onClose} busy={saving}
                   footer={(
                     <>
                       <button type="button" className="btn-solid" onClick={() => void publish()} disabled={saving}>
                         {saving ? 'Publishing…' : `Publish v${versionNo}`}
                       </button>
                       <button type="button" className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
                       {error && <span className="pf-error">{error}</span>}
                     </>
                   )}>
      <div className="pf-form">
        <div className="full">
          <label htmlFor="lrn-publish-note">What changed (optional)</label>
          <textarea id="lrn-publish-note" rows={4} maxLength={1000} value={note} disabled={saving}
                    placeholder="e.g. Added the ESD wrist strap rule"
                    onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
    </LearningModal>
  );
}
