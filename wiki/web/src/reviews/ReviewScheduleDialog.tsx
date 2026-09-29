/** Review schedule… (a page's ⋯ menu, manage): how often the page asks
 *  to be confirmed still right. "Library default" follows the library's
 *  review interval (stored as null on the page); any other choice is the
 *  page's own. In the portal's modal header pattern, sized to its
 *  content. */
import { useEffect, useMemo, useState } from 'react';

import ComboBox from '@portal/components/ComboBox';
import { longDate } from '@portal/lib/format';
import { useToast } from '@portal/lib/notificationsContext';

import type { NodeDetailOut, NodeOut } from '../lib/types';
import { errorMessage, updateNode } from '../lib/wikiApi';
import { spaceReviewInterval } from './ReviewChip';

const INTERVALS = [3, 6, 12, 24];
const INHERIT = '';

const every = (months: number) => `Every ${months} months`;

interface Props {
  node: NodeDetailOut;
  onClose: () => void;
  onSaved: (node: NodeOut) => void;
}

export default function ReviewScheduleDialog({ node, onClose, onSaved }: Props) {
  const toast = useToast();
  const own = node.review?.own_interval_months ?? null;
  const spaceDefault = spaceReviewInterval(node.space);
  const [value, setValue] = useState(own === null ? INHERIT : String(own));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const spaceLabel = spaceDefault === null ? 'none' : `${spaceDefault} months`;
  const options = useMemo(() => {
    const months = own !== null && !INTERVALS.includes(own) ? [...INTERVALS, own].sort((a, b) => a - b) : INTERVALS;
    return [
      { value: INHERIT, label: `Library default: ${spaceLabel}` },
      ...months.map((m) => ({ value: String(m), label: every(m) })),
    ];
  }, [own, spaceLabel]);

  const changed = value !== (own === null ? INHERIT : String(own));

  const save = async () => {
    if (!changed || busy) return;
    setBusy(true);
    setError('');
    try {
      const saved = await updateNode(node.id, { review_interval_months: value === INHERIT ? null : Number(value) });
      toast('Review schedule saved.');
      onSaved(saved);
      onClose();
    } catch (err) {
      setBusy(false);
      setError(errorMessage(err, 'Couldn\'t save the review schedule. Try again.'));
    }
  };

  const nextReview = node.review?.next_review_at;
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card wiki-dialog-card" role="dialog"
           aria-modal="true" aria-labelledby="wiki-review-schedule-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Review schedule</div>
            <h3 id="wiki-review-schedule-title">Review schedule for “{node.title}”</h3>
            <p className="page-hint">
              When a review falls due, the page's owner is reminded to confirm it's still right.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="pf-form">
            <div className="full">
              <label htmlFor="wiki-review-every">Review every</label>
              <ComboBox inputId="wiki-review-every" options={options} value={value} onChange={setValue}
                        disabled={busy} ariaLabel="Review every" />
              <p className="wiki-field-note">
                {own === null
                  ? 'This page follows the library\'s schedule.'
                  : `This page has its own schedule (the library default is ${spaceLabel}).`}
                {nextReview ? ` Next review: ${longDate(nextReview)}.` : ''}
              </p>
            </div>
          </div>
          {error && <p className="pf-error" role="alert">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid" disabled={!changed || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
