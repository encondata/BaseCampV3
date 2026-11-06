/**
 * A manager's preview of a Slides document, the way a reader steps through
 * it: the slide, then one row (Back, a numbered dot per slide, "2 / 4", Next).
 * Unlike the reader nothing is gated or recorded: every dot opens at once.
 * The arrow keys move like Back and Next once the preview has focus.
 */

import { useState, type KeyboardEvent } from 'react';

export default function SlidesPreview({ slides }: { slides: string[] }) {
  const n = slides.length;
  const [at, setAt] = useState(0);
  // the slides can shrink under us when the document is republished
  const shown = Math.min(at, n - 1);
  const prev = () => setAt(Math.max(shown - 1, 0));
  const next = () => setAt(Math.min(shown + 1, n - 1));

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  };

  if (n === 0) return null;
  return (
    <section className="lrn-slides" role="region" aria-label="Slides" tabIndex={0} onKeyDown={onKey}>
      {/* the server sanitizes each slide's HTML when the version is published */}
      <div className="lrn-slide lrn-prose" dangerouslySetInnerHTML={{ __html: slides[shown] }} />
      <div className="lrn-slides-bar">
        <button type="button" className="mini-btn lrn-slides-btn" onClick={prev} disabled={shown === 0}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
               strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          Back
        </button>
        <div className="lrn-slides-dots">
          {slides.map((_, i) => (
            <button key={i} type="button" onClick={() => setAt(i)}
                    className={`lrn-slides-dot${i === shown ? ' on' : ''}`}
                    aria-label={`Go to slide ${i + 1}`} aria-current={i === shown ? 'step' : undefined}>
              {i + 1}
            </button>
          ))}
        </div>
        <span className="lrn-slides-count" aria-live="polite">{shown + 1} / {n}</span>
        <button type="button" className="mini-btn lrn-slides-btn" onClick={next} disabled={shown >= n - 1}>
          Next
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
               strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
        </button>
      </div>
    </section>
  );
}
