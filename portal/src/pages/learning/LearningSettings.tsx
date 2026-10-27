/**
 * /learning/settings — the learning policy: sign-in code limits, the
 * defaults a new initiative schedule and document start from, the subject
 * and intro of each email per language, the languages offered, the branding
 * line and sign-off retention. The form shows exactly what GET
 * /system/learning returns (a blank number is "no limit" / "keep"), checks
 * the values before it sends, and PUTs only the fields that changed. Reads
 * need learning:view; saving needs learning:change.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import ChipPicker from '../../components/ChipPicker';
import ComboBox from '../../components/ComboBox';
import {
  offsetLabel, REMINDER_CHOICES, TIME_CHOICES, timeLabel,
} from '../../components/learning/initiativeLearning';
import { useLearningAccess } from '../../components/learning/useLearningAccess';
import {
  getLearningSettings, LEARNING_LANGUAGES, languageName, putLearningSettings,
  type LearningSettings as Settings,
} from '../../lib/learning';
import { apiErrorText } from '../../lib/learningDoc';
import {
  EMAIL_KINDS, evaluate, isDirty, isValid, toDraft, type NumberKey, type SettingsDraft,
} from '../../lib/learningSettings';
import { compareOrdinal } from '../../lib/naturalSort';
import { useToast } from '../../lib/notificationsContext';
import '../../styles/directory.css';
import '../../styles/initiatives.css';   // .init-check pills (the languages)
import '../../styles/learning.css';
import '../../styles/profile.css';       // .panel, .pf-form

function Field({ id, label, hint, error, full = false, children }: {
  id?: string; label: string; hint?: ReactNode; error?: string; full?: boolean; children: ReactNode;
}) {
  return (
    <div className={full ? 'full' : undefined}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <p className="lrn-hint">{hint}</p>}
      {error && <p className="pf-error" role="alert">{error}</p>}
    </div>
  );
}

export default function LearningSettings() {
  const toast = useToast();
  const canChange = useLearningAccess()('change');
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<string>(EMAIL_KINDS[0].key);
  const [language, setLanguage] = useState('en');

  const load = useCallback(() => {
    setFailed(false);
    getLearningSettings()
      .then((s) => { setSaved(s); setDraft(toDraft(s)); })
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const result = useMemo(() => (saved && draft ? evaluate(draft, saved) : null), [saved, draft]);

  if (failed) {
    return (
      <div className="portal-page">
        <div className="eyebrow">Learning</div>
        <h1 className="page-title">Learning settings</h1>
        <div className="dash-panel-empty lrn-error" role="alert">
          <span>Couldn&apos;t load the settings.</span>
          <button type="button" className="mini-btn" onClick={load}>Try again</button>
        </div>
      </div>
    );
  }

  const ready = saved !== null && draft !== null && result !== null;
  const locked = !canChange || saving;
  const dirty = ready && isDirty(result);
  const valid = ready && isValid(result);

  const setNumber = (key: NumberKey, text: string) =>
    setDraft((d) => d && { ...d, numbers: { ...d.numbers, [key]: text } });
  const patchDraft = (p: Partial<SettingsDraft>) => setDraft((d) => d && { ...d, ...p });

  const number = (key: NumberKey, label: string, hint?: ReactNode) => (
    <Field id={`ls-${key}`} label={label} hint={hint} error={result?.errors[key]}>
      <input id={`ls-${key}`} inputMode="numeric" disabled={locked || !draft}
             value={draft?.numbers[key] ?? ''} aria-invalid={!!result?.errors[key]}
             onChange={(e) => setNumber(key, e.target.value)} />
    </Field>
  );

  // the email text is edited per offered language
  const languages: string[] = draft
    ? LEARNING_LANGUAGES.filter((l) => draft.languages.includes(l)) : [];
  const lang = languages.includes(language) ? language : 'en';
  const entry = draft?.email_text[kind]?.[lang] ?? { subject: '', intro: '' };
  const hasOverride = entry.subject.trim() !== '' || entry.intro.trim() !== '';
  const setEntry = (next: { subject?: string; intro?: string }) => setDraft((d) => {
    if (!d) return d;
    const byLang = { ...(d.email_text[kind] ?? {}), [lang]: { ...entry, ...next } };
    return { ...d, email_text: { ...d.email_text, [kind]: byLang } };
  });
  const resetEntry = () => setDraft((d) => {
    if (!d) return d;
    const byLang = { ...(d.email_text[kind] ?? {}) };
    delete byLang[lang];
    return { ...d, email_text: { ...d.email_text, [kind]: byLang } };
  });
  const kindLabel = (k: string) => EMAIL_KINDS.find((e) => e.key === k)?.label ?? k;
  const subjectError = result?.email.find((p) => p.kind === kind && p.lang === lang)?.text;
  const otherProblems = (result?.email ?? []).filter((p) => !(p.kind === kind && p.lang === lang));

  const save = async () => {
    if (!ready || !valid || !dirty || saving) return;
    setSaving(true);
    setError('');
    try {
      const next = await putLearningSettings(result.patch);
      setSaved(next);
      setDraft(toDraft(next));
      toast('Learning settings saved');
    } catch (err) {
      setError(apiErrorText(err, {}, "Couldn't save the settings. Try again."));
    } finally {
      setSaving(false);
    }
  };
  const discard = () => { if (saved) { setDraft(toDraft(saved)); setError(''); } };

  const reminderOptions = Array.from(new Set([
    ...REMINDER_CHOICES, ...(draft?.reminder_offsets.map(Number) ?? []),
  ])).sort((a, b) => a - b).map((n) => ({ value: String(n), label: offsetLabel(n) }));
  const timeValues = draft && !TIME_CHOICES.includes(draft.invite_time)
    ? [...TIME_CHOICES, draft.invite_time].sort(compareOrdinal) : TIME_CHOICES;

  return (
    <div className="portal-page lrn-settings">
      <div className="eyebrow">Learning</div>
      <div className="dash-head">
        <div>
          <h1 className="page-title">Learning settings</h1>
          <p className="page-hint">
            Code policy, defaults, email text and retention.
            {!canChange && ' You can view these but not change them.'}
          </p>
        </div>
      </div>

      {!ready && <div className="dash-panel-empty">Loading…</div>}
      {ready && (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
          <section className="panel" aria-label="Sign-in codes">
            <div className="panel-head"><h3>Sign-in codes</h3></div>
            <div className="panel-body">
              <div className="pf-form">
                {number('code_max_failures', 'Failed attempts before a lockout',
                  'A code locks after this many wrong tries.')}
                {number('code_lockout_seconds', 'Lockout length (seconds)')}
                {number('ip_limit', 'Failed attempts per IP address',
                  'Across every code, within the window below.')}
                {number('ip_window_seconds', 'Counting window (seconds)',
                  'How far back failed attempts are counted.')}
                {number('global_limit', 'Failed attempts across all addresses')}
                {number('general_code_days', 'General codes expire after (days)',
                  'Leave blank for no expiry.')}
              </div>
            </div>
          </section>

          <section className="panel" aria-label="Defaults">
            <div className="panel-head"><h3>Defaults</h3></div>
            <div className="panel-body">
              <div className="pf-form">
                {number('default_validity_days', 'Documents stay valid for (days)',
                  'Where a new document starts. Leave blank for no end date.')}
                {number('invite_offset_days', 'Send invites (days before the start)')}
                <Field label="Send at" id="ls-invite-time" error={result.errors.invite_time}>
                  <ComboBox inputId="ls-invite-time" ariaLabel="Send at" disabled={locked}
                            value={draft.invite_time}
                            onChange={(v) => v && patchDraft({ invite_time: v })}
                            options={timeValues.map((t) => ({ value: t, label: timeLabel(t) }))} />
                </Field>
                {number('due_offset_days', 'Due (days before the start)')}
                <Field label="Reminders (days before the start)" full>
                  <ChipPicker options={reminderOptions} selected={draft.reminder_offsets}
                              onChange={(v) => patchDraft({ reminder_offsets: v })} disabled={locked}
                              ariaLabel="Add a reminder day" placeholder="Add a reminder day…"
                              note={draft.reminder_offsets.length === 0 ? 'No reminders.' : undefined} />
                </Field>
              </div>
            </div>
          </section>

          <section className="panel" aria-label="Email text">
            <div className="panel-head"><h3>Email text</h3></div>
            <div className="panel-body">
              <div className="pf-form">
                <Field label="Template" id="ls-email-kind">
                  <select id="ls-email-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                    {EMAIL_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                  </select>
                </Field>
                <Field label="Language" id="ls-email-lang">
                  <select id="ls-email-lang" value={lang} onChange={(e) => setLanguage(e.target.value)}>
                    {languages.map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
                  </select>
                </Field>
                <Field label="Subject" id="ls-email-subject" full error={subjectError}
                       hint="Leave the subject and intro blank to use the built-in text. A language with no text of its own uses the English text.">
                  <input id="ls-email-subject" value={entry.subject} disabled={locked}
                         aria-invalid={!!subjectError}
                         onChange={(e) => setEntry({ subject: e.target.value })} />
                </Field>
                <Field label="Intro" id="ls-email-intro" full>
                  <textarea id="ls-email-intro" rows={4} value={entry.intro} disabled={locked}
                            onChange={(e) => setEntry({ intro: e.target.value })} />
                </Field>
                {canChange && (
                  <div className="full">
                    <button type="button" className="mini-btn" disabled={locked || !hasOverride}
                            onClick={resetEntry}>Reset to default</button>
                  </div>
                )}
                {otherProblems.map((p) => (
                  <p className="pf-error full" role="alert" key={`${p.kind}-${p.lang}`}>
                    {kindLabel(p.kind)} ({languageName(p.lang)}): {p.text}
                  </p>
                ))}
              </div>
            </div>
          </section>

          <section className="panel" aria-label="Languages">
            <div className="panel-head"><h3>Languages offered</h3></div>
            <div className="panel-body">
              <p className="lrn-hint" style={{ margin: '0 0 10px' }}>
                What workers can read and sign in. English is always on.
              </p>
              <div className="init-checks" role="group" aria-label="Languages offered">
                {LEARNING_LANGUAGES.map((l) => (
                  <label className="init-check" key={l}>
                    <input type="checkbox" checked={draft.languages.includes(l)}
                           disabled={locked || l === 'en'}
                           onChange={(e) => patchDraft({
                             languages: e.target.checked
                               ? [...draft.languages, l] : draft.languages.filter((x) => x !== l),
                           })} />
                    {languageName(l)}
                  </label>
                ))}
              </div>
            </div>
          </section>

          <section className="panel" aria-label="Branding and retention">
            <div className="panel-head"><h3>Branding and retention</h3></div>
            <div className="panel-body">
              <div className="pf-form">
                <Field label="Branding line" id="ls-brand" full
                       hint="Shown on the learn site and in emails.">
                  <input id="ls-brand" value={draft.brand_line} disabled={locked}
                         onChange={(e) => patchDraft({ brand_line: e.target.value })} />
                </Field>
                {number('retention_days', 'Keep sign-off records for (days)',
                  'Leave blank to keep them.')}
              </div>
            </div>
          </section>

          {canChange && (
            <div className="lrn-settings-actions">
              <button type="submit" className="btn-solid" disabled={!dirty || !valid || saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              {dirty && (
                <button type="button" className="mini-btn" disabled={saving} onClick={discard}>
                  Discard
                </button>
              )}
              {error && <span className="pf-error" role="alert">{error}</span>}
            </div>
          )}
        </form>
      )}
    </div>
  );
}
