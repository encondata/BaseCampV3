/**
 * The Learning settings form's model: the saved settings as text drafts,
 * their validation (the same rules as LearningSettingsIn in the API), and
 * the patch of just what changed. Nothing here invents a value: a blank
 * nullable number means "no limit / keep", and every other field is shown
 * exactly as GET /system/learning returned it.
 */
import type { LearningEmailText, LearningSettings, LearningSettingsPatch } from './learning';
import { compareOrdinal } from './naturalSort';

export const EMAIL_KINDS = [
  { key: 'invite', label: 'Invite' },
  { key: 'reminder', label: 'Reminder' },
  { key: 'complete', label: 'Completion' },
  { key: 'new_version', label: 'New version' },
  { key: 'link', label: 'Sign-in link' },
] as const;

/** The API caps a subject at one header line (LEARNING_SUBJECT_MAX). */
export const SUBJECT_MAX = 200;

export type NumberKey =
  | 'code_max_failures' | 'code_lockout_seconds' | 'ip_limit' | 'ip_window_seconds'
  | 'global_limit' | 'general_code_days' | 'default_validity_days' | 'invite_offset_days'
  | 'due_offset_days' | 'retention_days';

/** The numbers the API lets be null (the rule is off). */
const NULLABLE: NumberKey[] = ['general_code_days', 'default_validity_days', 'retention_days'];
const NUMBER_KEYS: NumberKey[] = [
  'code_max_failures', 'code_lockout_seconds', 'ip_limit', 'ip_window_seconds', 'global_limit',
  'general_code_days', 'default_validity_days', 'invite_offset_days', 'due_offset_days',
  'retention_days',
];

export type EmailText = Record<string, Record<string, LearningEmailText>>;

export interface SettingsDraft {
  numbers: Record<NumberKey, string>;
  invite_time: string;
  /** Days, as the picker holds them. */
  reminder_offsets: string[];
  brand_line: string;
  email_text: EmailText;
  languages: string[];
}

export const NUMBER_ERROR = 'Enter a whole number of 1 or more.';
export const SUBJECT_ERROR = `Keep the subject to ${SUBJECT_MAX} characters.`;

const cloneEmail = (text: EmailText): EmailText => {
  const out: EmailText = {};
  Object.entries(text).forEach(([kind, byLang]) => {
    out[kind] = {};
    Object.entries(byLang).forEach(([lang, t]) => { out[kind][lang] = { ...t }; });
  });
  return out;
};

export function toDraft(s: LearningSettings): SettingsDraft {
  const numbers = {} as Record<NumberKey, string>;
  NUMBER_KEYS.forEach((k) => { numbers[k] = s[k] === null ? '' : String(s[k]); });
  return {
    numbers, invite_time: s.invite_time, reminder_offsets: s.reminder_offsets.map(String),
    brand_line: s.brand_line, email_text: cloneEmail(s.email_text), languages: [...s.languages],
  };
}

/** An entry with neither a subject nor an intro is the built-in text, so it
 *  isn't stored at all. */
export function pruneEmailText(text: EmailText): EmailText {
  const out: EmailText = {};
  Object.entries(text).forEach(([kind, byLang]) => {
    Object.entries(byLang).forEach(([lang, t]) => {
      if (t.subject.trim() === '' && t.intro.trim() === '') return;
      (out[kind] ??= {})[lang] = { subject: t.subject, intro: t.intro };
    });
  });
  return out;
}

export interface EmailProblem { kind: string; lang: string; text: string }

export interface Evaluation {
  /** Field key → message (numbers by their own key). */
  errors: Partial<Record<NumberKey | 'invite_time', string>>;
  email: EmailProblem[];
  /** Only what differs from the saved settings. */
  patch: LearningSettingsPatch;
}

const WHOLE = /^\d+$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const sameList = (a: number[], b: number[]) =>
  a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

export function evaluate(draft: SettingsDraft, saved: LearningSettings): Evaluation {
  const errors: Evaluation['errors'] = {};
  const patch: Record<string, unknown> = {};

  NUMBER_KEYS.forEach((key) => {
    const text = draft.numbers[key].trim();
    let value: number | null;
    if (text === '' && NULLABLE.includes(key)) {
      value = null;
    } else if (WHOLE.test(text) && Number(text) >= 1) {
      value = Number(text);
    } else {
      errors[key] = NUMBER_ERROR;
      return;
    }
    if (value !== saved[key]) patch[key] = value;
  });

  if (!HHMM.test(draft.invite_time)) errors.invite_time = 'Pick a time of day.';
  else if (draft.invite_time !== saved.invite_time) patch.invite_time = draft.invite_time;

  const reminders = draft.reminder_offsets.map(Number);
  if (!sameList(reminders, saved.reminder_offsets)) {
    patch.reminder_offsets = [...reminders].sort((a, b) => b - a);
  }
  if (draft.brand_line !== saved.brand_line) patch.brand_line = draft.brand_line;

  const languages = saved.available_languages.filter((l) => draft.languages.includes(l));
  const savedLanguages = new Set(saved.languages);
  if (languages.length !== savedLanguages.size || languages.some((l) => !savedLanguages.has(l))) {
    patch.languages = languages;
  }

  const email: EmailProblem[] = [];
  const pruned = pruneEmailText(draft.email_text);
  Object.entries(pruned).forEach(([kind, byLang]) => {
    Object.entries(byLang).forEach(([lang, t]) => {
      if (t.subject.length > SUBJECT_MAX) email.push({ kind, lang, text: SUBJECT_ERROR });
    });
  });
  if (JSON.stringify(sortedEmail(pruned)) !== JSON.stringify(sortedEmail(pruneEmailText(saved.email_text)))) {
    patch.email_text = pruned;
  }
  return { errors, email, patch: patch as LearningSettingsPatch };
}

/** A key-order-independent view, for comparing two email_text values. */
function sortedEmail(text: EmailText): unknown {
  return Object.keys(text).sort(compareOrdinal).map((kind) => [kind, Object.keys(text[kind]).sort(compareOrdinal)
    .map((lang) => [lang, text[kind][lang].subject, text[kind][lang].intro])]);
}

export const isValid = (e: Evaluation): boolean =>
  Object.keys(e.errors).length === 0 && e.email.length === 0;

export const isDirty = (e: Evaluation): boolean => Object.keys(e.patch).length > 0;
