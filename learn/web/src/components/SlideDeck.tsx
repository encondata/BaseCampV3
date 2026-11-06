/** A Slides document, one slide at a time: the slide, then one row (Back,
 *  a numbered dot per slide, "2 / 4", Next) and a status line saying what
 *  is still needed.
 *
 *  Next always goes to the following slide. The furthest slide reached
 *  grows by one per Next and is reported first: the server refuses
 *  anything further ahead and its answer is what the dots show, so when
 *  the call fails (offline, a refusal) the deck stays on the slide it was
 *  on and says so, with a Try again button. Any slide up to the furthest reached opens from its dot.
 *  The arrow keys move like Back and Next, the way the text reads (in
 *  right-to-left text the left arrow goes forward).
 *
 *  Review (a signed document): every dot opens, nothing is reported and
 *  there is no status line. */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { t } from '../lib/i18n';

export default function SlideDeck({ slides, reached, review, lang, dir, onReach }: {
  slides: string[];
  /** The furthest slide the server recorded (0-based), null before any. */
  reached: number | null;
  review: boolean;
  /** The slides' language and direction (the document's, not the screen's). */
  lang: string;
  dir: 'ltr' | 'rtl';
  /** Report reaching slide `n`: the server's `slide_reached`, or null when the call failed. */
  onReach: (n: number) => Promise<number | null>;
}) {
  const n = slides.length;
  const last = n - 1;
  // a reopened assignment resumes where the reading stopped; a signed one
  // starts at the beginning with everything open
  const [far, setFar] = useState(review ? last : reached ?? -1);
  const [at, setAt] = useState(review ? 0 : Math.min(Math.max(reached ?? 0, 0), last));
  const [failed, setFailed] = useState(false);
  // one report at a time: a double tap on Next can't skip a slide
  const pending = useRef(false);

  const report = async (k: number): Promise<boolean> => {
    const got = await onReach(k);
    if (got === null) {
      setFailed(true);
      return false;
    }
    setFailed(false);
    setFar((f) => Math.max(f, got));
    return true;
  };

  // opening the first slide counts as reaching it
  useEffect(() => {
    if (review || reached !== null) return;
    pending.current = true;
    void report(0).finally(() => { pending.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const next = async () => {
    if (at >= last || pending.current) return;
    const to = at + 1;
    if (!review && to > far) {
      pending.current = true;
      try {
        // the slide on screen first, when opening it wasn't recorded
        if (far < at && !(await report(at))) return;
        if (!(await report(to))) return;
      } finally {
        pending.current = false;
      }
    }
    setAt(to);
  };
  const prev = () => { if (at > 0) setAt(at - 1); };
  // the slide on screen again: a one-slide deck whose opening report failed
  // has no Next to tap
  const retry = async () => {
    if (pending.current) return;
    pending.current = true;
    try { await report(at); } finally { pending.current = false; }
  };

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const backward = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === forward) { e.preventDefault(); void next(); }
    else if (e.key === backward) { e.preventDefault(); prev(); }
  };

  const status = review ? ''
    : failed ? t('slides.saveFailed')
    : far < last ? t('slides.progress', { seen: Math.max(far, at) + 1, n })
    : '';
  return (
    <section className="learn-slides" role="region" aria-label={t('slides.region')} tabIndex={0} dir={dir} onKeyDown={onKey}>
      {/* the server sanitizes the HTML and snapshots the version */}
      <div className="learn-slide" lang={lang} dangerouslySetInnerHTML={{ __html: slides[at] }} />

      <div className="learn-slides-row">
        <button type="button" className="learn-slides-back" onClick={prev} disabled={at === 0}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
               strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          {t('slides.back')}
        </button>
        <div className="learn-slides-dots">
          {slides.map((_, i) => {
            const open = i <= far || i === at;
            return (
              <button key={i} type="button" disabled={!open} onClick={() => setAt(i)}
                      className={`learn-slides-dot${i === at ? ' current' : open ? ' seen' : ''}`}
                      aria-label={t('slides.goTo', { k: i + 1 })} aria-current={i === at ? 'step' : undefined}
                      title={open ? undefined : t('slides.notReached')}>
                {i + 1}
              </button>
            );
          })}
        </div>
        <span className="learn-slides-count" aria-live="polite">{t('slides.count', { k: at + 1, n })}</span>
        <button type="button" className="learn-cta learn-slides-next" onClick={() => void next()}
                disabled={at >= last}>
          {t('slides.next')}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
               strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
        </button>
      </div>

      {/* always mounted while it can speak, so a screen reader hears it change */}
      {!review && (
        <div className="learn-slides-statusrow">
          <p className={`learn-slides-status${failed ? ' bad' : ''}`} aria-live="polite">{status}</p>
          {failed && (
            <button type="button" className="learn-link" onClick={() => void retry()}>{t('slides.retry')}</button>
          )}
        </div>
      )}
    </section>
  );
}
