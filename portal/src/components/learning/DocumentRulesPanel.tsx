/**
 * The rules column of a document's "Content and rules" tab (mockup view
 * "Document settings"): valid for, the re-sign rule as two option cards, how
 * they sign, the reading rules, and read-only summaries of translations and
 * recent versions. Every change autosaves as a PATCH of just that field (the
 * page toasts "Saved"); a failed save puts the old value back. Controls render
 * only for learning:change — a view-only manager gets the same values as text.
 *
 * Numbers are never filled in for the user: Custom days and the minimum
 * reading seconds start empty and save once a whole number is typed.
 */

import { useEffect, useState } from 'react';

import {
  languageName, type DocumentPatch, type DocumentSettings, type LearningDocument,
  type ResignRule, type SignStyle, type TranslationStatusRow,
} from '../../lib/learning';
import {
  positiveInt, RESIGN_OPTIONS, shortDate, SIGN_STYLES, TRANSLATION_STATUS,
  validityChoice, validityText, VALIDITY_OPTIONS, type ValidityChoice,
} from '../../lib/learningDoc';
import { Switch } from '../Switch';
import '../../styles/learning.css';

export type DocTab = 'content' | 'quiz' | 'translations' | 'versions' | 'signoffs';

export default function DocumentRulesPanel({
  doc, canChange, onSave, translations, signoffCounts, onOpenTab,
}: {
  doc: LearningDocument;
  canChange: boolean;
  /** Saves a partial update; resolves false when it failed (the page says why). */
  onSave: (patch: DocumentPatch) => Promise<boolean>;
  translations: TranslationStatusRow[] | null;
  /** Version id → sign-off count. */
  signoffCounts: Record<string, number> | null;
  onOpenTab: (tab: DocTab) => void;
}) {
  // What the user just chose, until the save lands (or fails and it goes).
  const [pending, setPending] = useState<Partial<DocumentSettings>>({});
  const shown: DocumentSettings = { ...doc, ...pending };

  const apply = async (patch: Partial<DocumentSettings>) => {
    setPending((p) => ({ ...p, ...patch }));
    const ok = await onSave(patch);
    setPending((p) => {
      const next = { ...p };
      (Object.keys(patch) as (keyof DocumentSettings)[]).forEach((k) => { delete next[k]; });
      return next;
    });
    return ok;
  };

  // Custom days
  const [customOpen, setCustomOpen] = useState(false);
  const [daysText, setDaysText] = useState(shown.validity_days === null ? '' : String(shown.validity_days));
  const [daysError, setDaysError] = useState('');
  useEffect(() => {
    setDaysText(doc.validity_days === null ? '' : String(doc.validity_days));
  }, [doc.validity_days]);
  const choice: ValidityChoice = customOpen ? 'custom' : validityChoice(shown.validity_days);

  const pickValidity = (value: ValidityChoice) => {
    setDaysError('');
    if (value === 'custom') { setCustomOpen(true); return; }
    setCustomOpen(false);
    const days = value === 'never' ? null : Number(value);
    if (days !== shown.validity_days) void apply({ validity_days: days });
  };
  const commitDays = () => {
    const n = positiveInt(daysText);
    if (n === null) { setDaysError('Enter a whole number of days, 1 or more.'); return; }
    setDaysError('');
    if (n === shown.validity_days) return;
    void apply({ validity_days: n }).then((ok) => { if (ok) setCustomOpen(false); });
  };

  // Minimum reading time
  const [minDraftOn, setMinDraftOn] = useState(false);
  const [secondsText, setSecondsText] = useState(shown.min_read_seconds === null ? '' : String(shown.min_read_seconds));
  const [secondsError, setSecondsError] = useState('');
  useEffect(() => {
    setSecondsText(doc.min_read_seconds === null ? '' : String(doc.min_read_seconds));
  }, [doc.min_read_seconds]);
  const minOn = shown.min_read_seconds !== null || minDraftOn;
  const toggleMin = (on: boolean) => {
    setSecondsError('');
    if (on) { setMinDraftOn(true); return; }
    setMinDraftOn(false);
    if (shown.min_read_seconds !== null) void apply({ min_read_seconds: null });
  };
  const commitSeconds = () => {
    const n = positiveInt(secondsText);
    if (n === null) { setSecondsError('Enter a whole number of seconds, 1 or more.'); return; }
    setSecondsError('');
    if (n === shown.min_read_seconds) return;
    void apply({ min_read_seconds: n }).then((ok) => { if (ok) setMinDraftOn(false); });
  };

  // Quiz on/off: a quiz needs a pass mark (and locking needs an attempt limit)
  const [quizNote, setQuizNote] = useState('');
  const toggleQuiz = (on: boolean) => {
    setQuizNote('');
    if (on && shown.quiz_pass_percent === null) {
      setQuizNote('Set a pass mark on the Quiz tab first.');
      return;
    }
    if (on && shown.quiz_fail_action === 'lock' && shown.quiz_max_attempts === null) {
      setQuizNote('Set how many attempts are allowed on the Quiz tab first.');
      return;
    }
    void apply({ quiz_enabled: on });
  };

  const resign = (value: ResignRule) => { if (value !== shown.resign_rule) void apply({ resign_rule: value }); };
  const signStyle = (value: SignStyle) => { if (value !== shown.sign_style) void apply({ sign_style: value }); };

  const recent = doc.versions.slice(0, 2);
  const resignTitle = RESIGN_OPTIONS.find((o) => o.value === shown.resign_rule)?.title ?? '';
  const styleLabel = SIGN_STYLES.find((s) => s.value === shown.sign_style)?.label ?? '';

  return (
    <div className="lrn-rules">
      <div className="lrn-set">
        {canChange
          ? <label className="lrn-lbl" htmlFor="lrn-validity">Valid for</label>
          : <span className="lrn-lbl">Valid for</span>}
        {canChange ? (
          <>
            <div className="lrn-validity">
              <select id="lrn-validity" value={choice}
                      onChange={(e) => pickValidity(e.target.value as ValidityChoice)}>
                {VALIDITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {choice === 'custom' && (
                <input className="lrn-num" inputMode="numeric" aria-label="Custom validity in days"
                       value={daysText} placeholder="Days"
                       onChange={(e) => { setDaysText(e.target.value); setDaysError(''); }}
                       onBlur={commitDays}
                       onKeyDown={(e) => { if (e.key === 'Enter') commitDays(); }} />
              )}
            </div>
            {daysError && <p className="pf-error">{daysError}</p>}
          </>
        ) : (
          <p className="lrn-val">{validityText(shown.validity_days)}</p>
        )}
        <p className="lrn-hint">A sign-off stays valid until the end of any initiative it covers.</p>
      </div>

      <div className="lrn-set">
        <span className="lrn-lbl" id="lrn-resign-label">When someone joins a new initiative</span>
        {canChange ? (
          <div className="lrn-opts" role="radiogroup" aria-labelledby="lrn-resign-label">
            {RESIGN_OPTIONS.map((o) => {
              const on = shown.resign_rule === o.value;
              return (
                <button key={o.value} type="button" role="radio" aria-checked={on}
                        className={`lrn-opt${on ? ' on' : ''}`} onClick={() => resign(o.value)}>
                  <span className="lrn-radio" aria-hidden="true" />
                  <span className="lrn-opt-text">
                    <span className="lrn-opt-t">{o.title}</span>
                    <span className="lrn-opt-s">{o.sub}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="lrn-val">{resignTitle}</p>
        )}
      </div>

      <div className="lrn-set">
        <span className="lrn-lbl">How they sign</span>
        {canChange ? (
          <div className="segmented" role="group" aria-label="How they sign">
            {SIGN_STYLES.map((s) => (
              <button key={s.value} type="button" aria-pressed={shown.sign_style === s.value}
                      className={shown.sign_style === s.value ? 'on' : ''}
                      onClick={() => signStyle(s.value)}>{s.label}</button>
            ))}
          </div>
        ) : (
          <p className="lrn-val">{styleLabel}</p>
        )}
      </div>

      <div className="lrn-set">
        <span className="lrn-lbl">Reading rules</span>
        {canChange ? (
          <>
            <div className="lrn-toggle">
              <span>Must scroll to the end</span>
              <Switch checked={shown.require_scroll} label="Must scroll to the end"
                      onChange={(v) => void apply({ require_scroll: v })} />
            </div>
            <div className="lrn-toggle">
              <span>Minimum reading time</span>
              <span className="lrn-toggle-end">
                {minOn && (
                  <>
                    <input className="lrn-num" inputMode="numeric"
                           aria-label="Minimum reading time in seconds" value={secondsText}
                           placeholder="Seconds"
                           onChange={(e) => { setSecondsText(e.target.value); setSecondsError(''); }}
                           onBlur={commitSeconds}
                           onKeyDown={(e) => { if (e.key === 'Enter') commitSeconds(); }} />
                    <span className="lrn-unit">sec</span>
                  </>
                )}
                <Switch checked={minOn} label="Minimum reading time" onChange={toggleMin} />
              </span>
            </div>
            {secondsError && <p className="pf-error">{secondsError}</p>}
            {minDraftOn && !secondsError && shown.min_read_seconds === null && (
              <p className="lrn-hint">Enter the seconds workers must stay on the page.</p>
            )}
            <div className="lrn-toggle">
              <span>Quiz after reading</span>
              <Switch checked={shown.quiz_enabled} label="Quiz after reading" onChange={toggleQuiz} />
            </div>
            {quizNote && (
              <p className="pf-error">
                {quizNote}{' '}
                <button type="button" className="mini-btn" onClick={() => onOpenTab('quiz')}>Open the Quiz tab</button>
              </p>
            )}
          </>
        ) : (
          <dl className="kv">
            <dt>Scroll to the end</dt><dd>{shown.require_scroll ? 'Required' : 'Not required'}</dd>
            <dt>Minimum reading</dt>
            <dd>{shown.min_read_seconds === null ? 'Off' : `${shown.min_read_seconds} sec`}</dd>
            <dt>Quiz</dt><dd>{shown.quiz_enabled ? 'On' : 'Off'}</dd>
          </dl>
        )}
      </div>

      <div className="lrn-set">
        <span className="lrn-lbl">
          Translations
          <button type="button" className="lrn-link" onClick={() => onOpenTab('translations')}>Manage</button>
        </span>
        {translations === null && <p className="lrn-hint">Loading…</p>}
        {translations !== null && translations.length === 0 && <p className="lrn-hint">No languages are set up.</p>}
        {translations?.map((t) => {
          const meta = TRANSLATION_STATUS[t.status];
          const stale = t.status === 'out_of_date' && t.version_no !== null ? ` (v${t.version_no})` : '';
          const published = t.status === 'published' && t.version_no !== null ? ` v${t.version_no}` : '';
          return (
            <div key={t.language} className="lrn-line">
              <span>{languageName(t.language)}</span>
              <span className={`chip ${meta.cls}`}>{meta.label}{stale}{published}</span>
            </div>
          );
        })}
      </div>

      <div className="lrn-set">
        <span className="lrn-lbl">Recent versions</span>
        {recent.length === 0 && <p className="lrn-hint">Nothing published yet.</p>}
        {recent.map((v) => {
          const signed = signoffCounts?.[v.id];
          return (
            <div key={v.id} className="lrn-ver">
              <span className="lrn-vn">v{v.version_no}</span>
              <div>
                <div>{v.change_note || 'No note'}</div>
                <div className="lrn-hint">
                  {[shortDate(v.published_at), v.published_by?.name, signed === undefined ? null : `${signed} signed`]
                    .filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
