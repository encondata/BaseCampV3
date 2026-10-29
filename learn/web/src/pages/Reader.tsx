/** Read and sign one document (mockup screens 4): the header ("4 of 5 ·
 *  v2"), the sanitized HTML in a scroll box, the notices (not translated,
 *  what changed), the agreement and the signature, then "Sign and
 *  continue".
 *
 *  The button always works: tapping it before the sign-off is ready says
 *  why (agree, name or drawing, scroll, time left) instead of sitting
 *  disabled. The server checks the same rules and has the last word. The
 *  order is read, quiz, sign: a document with a quiz that isn't passed yet
 *  swaps the signature for "Take the quiz", and the worker comes back here,
 *  quiz passed, to sign — already read, so the scroll and reading-time
 *  gates don't start over (the server still counts from when it was
 *  opened). The sign-off names the version shown; if a newer one was
 *  published meanwhile the server refuses (409 `version_changed`) and the
 *  page loads the new version to read.
 *
 *  A signed document opens read-only (from the list or the history): the
 *  header, a "You signed this on …" notice and the text at the version
 *  that was signed, then Back — no agreement, signature, quiz or timer. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';

import { ApiError } from '@portal/lib/api';

import LoadState from '../components/LoadState';
import SignaturePad from '../components/SignaturePad';
import type { MessageKey } from '../i18n/en';
import { errorKey } from '../lib/errors';
import { mmss, signedDay } from '../lib/format';
import { isUuid } from '../lib/ids';
import { getLang, isRtl, t, useLang } from '../lib/i18n';
import { getAssignment, getTraining, signAssignment, type AssignmentRead } from '../lib/training';
import { useLoad } from '../lib/useLoad';

type Reason = { key: MessageKey; vars?: Record<string, string | number> };

/** Where this document sits in its list ("4 of 5"), when the list loads. */
async function position(id: string): Promise<{ k: number; n: number } | null> {
  try {
    const { groups } = await getTraining();
    for (const g of groups) {
      const at = g.items.findIndex((i) => i.assignment_id === id);
      if (at >= 0) return { k: at + 1, n: g.items.length };
    }
  } catch { /* the header just shows the version */ }
  return null;
}

function ReaderBody({ id, doc, place, changed, onVersionChanged }: {
  id: string; doc: AssignmentRead; place: { k: number; n: number } | null;
  changed: boolean; onVersionChanged: () => void;
}) {
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from;
  // signed: read-only, so none of the sign-off gating below applies
  const review = !!doc.signed_at;
  const box = useRef<HTMLDivElement>(null);
  const started = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  // the worker scrolled to the bottom (stays true), or the text fits the
  // box and there is nothing to scroll (re-checked as images load)
  const [reached, setReached] = useState(false);
  const [fits, setFits] = useState(false);
  // back from a passed quiz: the reading happened before it — unless a
  // newer version came in since, which the worker hasn't read yet (the
  // pass is per assignment, not per version)
  const alreadyRead = doc.has_quiz && doc.quiz_passed && !changed;
  const scrolled = reached || fits || alreadyRead;
  // the server's own clock said "not yet": hold off until then
  const [holdUntil, setHoldUntil] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [name, setName] = useState('');
  const [drawn, setDrawn] = useState<string | null>(null);
  const [reason, setReason] = useState<Reason | null>(null);
  const [busy, setBusy] = useState(false);

  const checkFit = () => {
    const el = box.current;
    if (el) setFits(el.scrollHeight <= el.clientHeight + 8);
  };
  const checkEnd = () => {
    const el = box.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setReached(true);
  };
  useLayoutEffect(checkFit, [doc.html]);
  // text that grows after the first paint (images arriving, the window
  // turning) is measured again
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(checkFit);
    watch.observe(el);
    if (el.firstElementChild) watch.observe(el.firstElementChild);
    return () => watch.disconnect();
  }, [doc.html]);

  const needsQuiz = doc.has_quiz && !doc.quiz_passed;
  const minSeconds = alreadyRead ? 0 : doc.min_read_seconds ?? 0;
  const elapsed = Math.floor((now - started.current) / 1000);
  const left = Math.max(0, minSeconds - elapsed, Math.ceil((holdUntil - now) / 1000));
  const ready = review || (scrolled && left <= 0);
  useEffect(() => {
    if (ready) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ready]);

  const sign = async () => {
    if (busy) return;
    const typed = doc.sign_style === 'typed_name';
    const draws = doc.sign_style === 'drawn_signature';
    // the same order the server checks in
    const why: Reason | null =
      !agreed ? { key: 'sign.mustAgree' }
      : typed && !name.trim() ? { key: 'sign.nameRequired' }
      : draws && !drawn ? { key: 'sign.signatureRequired' }
      : doc.require_scroll && !scrolled ? { key: 'sign.scrollRequired' }
      : left > 0 ? { key: 'sign.readTime', vars: { time: mmss(left) } }
      : null;
    setReason(why);
    if (why) return;

    setBusy(true);
    try {
      const out = await signAssignment(id, {
        agreed: true,
        ...(typed ? { typed_name: name.trim() } : {}),
        ...(draws && drawn ? { signature_png_b64: drawn } : {}),
        language: doc.language,
        scrolled_to_end: scrolled,
        version_no: doc.version_no,
      });
      navigate(out.complete ? '/done' : '/training', { replace: true });
    } catch (err) {
      setBusy(false);
      const code = err instanceof ApiError ? err.code : '';
      if (code === 'already_signed') { navigate('/training', { replace: true }); return; }
      if (code === 'quiz_required') { navigate(`/training/${id}/quiz`, { replace: true }); return; }
      if (code === 'version_changed') { onVersionChanged(); return; }
      if (code === 'scroll_required') { setReason({ key: 'sign.scrollRequired' }); return; }
      if (code === 'read_time') {
        const left = (err as ApiError).detail as { seconds_left?: unknown } | undefined;
        const secs = Math.max(1, Number(left?.seconds_left) || 1);
        setHoldUntil(Date.now() + secs * 1000);
        setNow(Date.now());
        setReason({ key: 'sign.readTime', vars: { time: mmss(secs) } });
        return;
      }
      setReason({ key: code === 'must_agree' ? 'sign.mustAgree'
        : code === 'name_required' ? 'sign.nameRequired'
        : code === 'signature_required' ? 'sign.signatureRequired'
        : errorKey(err) });
    }
  };

  const rtl = isRtl(doc.language);
  const back = from === '/history' ? '/history' : '/training';
  return (
    <>
      <div className="learn-readhead">
        <Link to={back} className="learn-backlink" aria-label={t('common.back')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
               strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5m6-6-6 6 6 6" /></svg>
        </Link>
        <div>
          <div className="eyebrow">
            {place ? t('reader.position', { k: place.k, n: place.n, v: doc.version_no })
              : t('reader.versionOnly', { v: doc.version_no })}
          </div>
          <h1 className="learn-doctitle">{doc.title}</h1>
        </div>
      </div>

      {review && doc.signed_at && (
        <p className="learn-banner">
          {t('reader.signedOn', { date: signedDay(doc.signed_at), v: doc.version_no })}
        </p>
      )}
      {doc.fallback && <p className="learn-banner">{t('reader.fallback')}</p>}
      {doc.change_note && <p className="learn-banner">{t('reader.changed', { note: doc.change_note })}</p>}

      <div ref={box} className="learn-doc" role="region" aria-label={t('reader.body')} tabIndex={0}
           lang={doc.language} dir={rtl ? 'rtl' : 'ltr'} onScroll={checkEnd} onLoadCapture={checkFit}>
        {/* the server sanitizes the HTML and snapshots the version */}
        <div dangerouslySetInnerHTML={{ __html: doc.html }} />
      </div>

      {!review && !needsQuiz && !alreadyRead && (doc.require_scroll || minSeconds > 0) && scrolled && left <= 0 && (
        <p className="learn-readdone">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
               strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m8 12.5 3 3 5-6" /></svg>
          {t('reader.readToEnd', { time: mmss(elapsed) })}
        </p>
      )}

      {review ? (
        <Link className="learn-cta" to={back}>{t('reader.back')}</Link>
      ) : needsQuiz ? (
        <Link className="learn-cta" to={`/training/${encodeURIComponent(id)}/quiz`}>{t('reader.takeQuiz')}</Link>
      ) : (
        <>
          <label className="learn-agree">
            <input type="checkbox" checked={agreed} disabled={busy}
                   onChange={(e) => { setAgreed(e.target.checked); setReason(null); }} />
            <span>{t('reader.agree', { title: doc.title })}</span>
          </label>

          {doc.sign_style === 'typed_name' && (
            <div className="learn-field">
              <label htmlFor="learn-sign-name">{t('reader.typeName')}</label>
              <input id="learn-sign-name" className="learn-sig" type="text" autoComplete="name" value={name}
                     disabled={busy} onChange={(e) => { setName(e.target.value); setReason(null); }} />
            </div>
          )}
          {doc.sign_style === 'drawn_signature' && (
            <div className="learn-field">
              <span className="learn-fieldlabel">{t('reader.drawSignature')}</span>
              <SignaturePad onChange={(png) => { setDrawn(png); setReason(null); }} />
            </div>
          )}

          {/* always mounted, so a screen reader hears the text when it changes */}
          <p className={`learn-reason ${reason ? 'show' : ''}`} role="status" aria-live="polite">
            {reason ? t(reason.key, reason.vars) : ''}
          </p>
          <button type="button" className="learn-cta" onClick={sign} disabled={busy}>
            {busy ? t('reader.signing') : t('reader.sign')}
          </button>
        </>
      )}
    </>
  );
}

function ReaderPage({ id }: { id: string }) {
  useLang();
  const lang = getLang();
  const doc = useLoad(() => getAssignment(id, lang), [id, lang]);
  const place = useLoad(() => position(id), [id]);
  // a newer version was published while the worker read the last one
  const [changed, setChanged] = useState(false);
  return (
    <main className="learn-page learn-reader">
      {changed && <p className="learn-banner" role="status">{t('reader.versionChanged')}</p>}
      {doc.data
        ? <ReaderBody key={`${id}:${doc.data.language}:${doc.data.version_no}`} id={id} doc={doc.data}
                      place={place.data} changed={changed}
                      onVersionChanged={() => { setChanged(true); doc.reload(); }} />
        : <LoadState error={doc.error} onRetry={doc.reload} />}
    </main>
  );
}

export default function Reader() {
  const { id = '' } = useParams();
  // the id is typed into the address bar: only a real one goes into a path
  return isUuid(id) ? <ReaderPage id={id} /> : <Navigate to="/training" replace />;
}
