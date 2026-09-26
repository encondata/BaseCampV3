/** The "Was this page helpful? Yes / No" footer under a published page.
 *  An answer is saved as soon as it's picked; after a No the reader may
 *  add a comment (optional — Skip leaves just the No). Then a thank-you,
 *  and the reader can change their answer any time: an earlier answer
 *  shows instead of the question when they come back. Re-picking No
 *  keeps the comment they already left. Mount it keyed by the page. */
import { useEffect, useState } from 'react';

import { useToast } from '@portal/lib/notificationsContext';

import type { FeedbackIn, FeedbackOut } from '../lib/types';
import { errorMessage, getMyFeedback, putFeedback } from '../lib/wikiApi';

/** The API's cap on a comment. */
export const COMMENT_MAX = 2000;

type Phase = 'loading' | 'ask' | 'comment' | 'thanks' | 'answered';

export default function HelpfulFooter({ pageId }: { pageId: string }) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('loading');
  const [answer, setAnswer] = useState<FeedbackOut | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getMyFeedback(pageId)
      .then((mine) => { if (live) { setAnswer(mine); setPhase('answered'); } })
      // none yet (404), or unreadable: just ask
      .catch(() => { if (live) setPhase('ask'); });
    return () => { live = false; };
  }, [pageId]);

  const save = async (body: FeedbackIn): Promise<FeedbackOut | null> => {
    setBusy(true);
    try {
      const saved = await putFeedback(pageId, body);
      setAnswer(saved);
      return saved;
    } catch (err) {
      toast(errorMessage(err, 'Couldn\'t save your answer.'));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const pickYes = async () => {
    if (await save({ helpful: true })) setPhase('thanks');
  };

  const pickNo = async () => {
    const kept = answer && !answer.helpful ? answer.comment : null;
    const saved = await save(kept ? { helpful: false, comment: kept } : { helpful: false });
    if (saved) {
      setComment(saved.comment ?? '');
      setPhase('comment');
    }
  };

  const sendComment = async () => {
    if (await save({ helpful: false, comment: comment.trim() })) setPhase('thanks');
  };

  if (phase === 'loading') return null;

  const change = (
    <button type="button" className="btn-ghost wiki-helpful-change" onClick={() => setPhase('ask')}>
      Change your answer
    </button>
  );

  return (
    <section className="wiki-helpful" aria-label="Page feedback">
      {phase === 'ask' && (
        <div className="wiki-helpful-row">
          <span className="wiki-helpful-q">Was this page helpful?</span>
          <button type="button" className={`mini-btn${answer?.helpful === true ? ' on' : ''}`}
                  aria-pressed={answer?.helpful === true} disabled={busy} onClick={() => void pickYes()}>
            Yes
          </button>
          <button type="button" className={`mini-btn${answer?.helpful === false ? ' on' : ''}`}
                  aria-pressed={answer?.helpful === false} disabled={busy} onClick={() => void pickNo()}>
            No
          </button>
        </div>
      )}
      {phase === 'comment' && (
        <div className="wiki-helpful-comment">
          <label htmlFor={`wiki-helpful-${pageId}`} className="wiki-helpful-q">What was missing or wrong?</label>
          <span className="page-hint">Optional — the space's managers read these to improve the page.</span>
          <textarea id={`wiki-helpful-${pageId}`} rows={3} maxLength={COMMENT_MAX} value={comment}
                    onChange={(e) => setComment(e.target.value)} />
          <div className="wiki-helpful-actions">
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => setPhase('thanks')}>Skip</button>
            <button type="button" className="btn-solid" disabled={busy || !comment.trim()}
                    onClick={() => void sendComment()}>
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      )}
      {phase === 'thanks' && (
        <div className="wiki-helpful-row">
          <span className="wiki-helpful-q">Thanks for your feedback.</span>
          {change}
        </div>
      )}
      {phase === 'answered' && answer && (
        <div className="wiki-helpful-row">
          <span className="wiki-helpful-q">
            {answer.helpful ? 'You found this page helpful.' : 'You said this page wasn\'t helpful.'}
          </span>
          {change}
        </div>
      )}
    </section>
  );
}
