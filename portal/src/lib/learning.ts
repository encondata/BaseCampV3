/**
 * Typed client for the learning API: every /learning/* route (library,
 * packets, rules, assignments, an initiative's Learning tab, translations,
 * the quiz pool, the dashboard, history and certificates) plus the
 * learning settings at /system/learning. Types mirror
 * api/src/serversherpa/learning/schemas.py (and LearningSettings* in
 * api/schemas.py): uuids, dates and datetimes arrive as strings.
 *
 * Every call goes through apiFetch and throws the portal's ApiError (status,
 * code, detail) on a non-2xx. The server gates each route on learning
 * managers; the UI decides what to offer with canManageLearning (lib/access).
 */
import {
  apiFetch, createReportRun, downloadAttachment, errorFrom, listReportDefinitions,
  type ReportRun,
} from './api';

// ── shared ───────────────────────────────────────────────────────────

export type ResignRule = 'every_initiative' | 'expired_or_new_version';
export type SignStyle = 'checkbox' | 'typed_name' | 'drawn_signature';
export type QuizFailAction = 'retry' | 'lock';

export interface PersonRef { id: string; name: string }

/** The language tags the learning settings allow, in the order the API lists them. */
export const LEARNING_LANGUAGES = ['en', 'ja', 'ko', 'he'] as const;
export const LEARNING_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', ja: 'Japanese', ko: 'Korean', he: 'Hebrew',
};
export const languageName = (code: string): string => LEARNING_LANGUAGE_NAMES[code] ?? code;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const seg = (part: string): string => encodeURIComponent(part);

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = JSON_HEADERS;
    init.body = JSON.stringify(body);
  }
  const resp = await apiFetch(path, init);
  if (!resp.ok) throw await errorFrom(resp);
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

const get = <T>(path: string) => send<T>(path, 'GET');

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined) qs.set(k, v); });
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}

// ── documents (library) ──────────────────────────────────────────────

export interface DocumentSettings {
  summary: string | null;
  validity_days: number | null;
  resign_rule: ResignRule;
  sign_style: SignStyle;
  require_scroll: boolean;
  min_read_seconds: number | null;
  quiz_enabled: boolean;
  quiz_pass_percent: number | null;
  quiz_max_attempts: number | null;
  quiz_fail_action: QuizFailAction;
}

/** Create takes the title, the wiki page, and any settings to override. */
export type DocumentCreate = Partial<DocumentSettings> & { title: string; wiki_node_id: string };

/** Only the keys sent change; null clears the nullable settings only. */
export type DocumentPatch = Partial<DocumentSettings> & {
  title?: string; wiki_node_id?: string;
};

export interface WikiPageRef { id: string; title: string; published_version_no: number | null }

export interface VersionSummary {
  id: string; version_no: number; wiki_version_no: number | null; title: string;
  change_note: string | null; published_at: string; published_by: PersonRef | null;
}
export interface LearningVersion extends VersionSummary { html: string }

export interface LearningDocument extends DocumentSettings {
  id: string;
  title: string;
  wiki_node_id: string | null;
  /** The linked wiki page; null once it's trashed, purged or moved out. */
  wiki_page: WikiPageRef | null;
  /** The wiki page has a published version newer than the current snapshot. */
  has_wiki_changes: boolean;
  current_version_id: string | null;
  current_version_no: number | null;
  current_html: string | null;
  versions: VersionSummary[];
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export type TranslationStatus = 'draft' | 'in_review' | 'published' | 'out_of_date' | 'missing';

export interface LearningDocumentListItem {
  id: string;
  title: string;
  current_version_no: number | null;
  published_at: string | null;
  packets: string[];
  signoff_count: number;
  /** Language → its newest translation's status. */
  languages: Record<string, TranslationStatus>;
  archived_at: string | null;
}

/** A page in the learning wiki space, for the "link a page" picker. */
export interface WikiPageOption {
  id: string; title: string; path: string[]; published_version_no: number | null;
}

export const listLearningDocuments = (includeArchived = false) =>
  get<LearningDocumentListItem[]>(withQuery('/learning/documents',
    { include_archived: includeArchived ? 'true' : undefined }));

export const createLearningDocument = (body: DocumentCreate) =>
  send<LearningDocument>('/learning/documents', 'POST', body);

export const getLearningDocument = (id: string) =>
  get<LearningDocument>(`/learning/documents/${seg(id)}`);

export const patchLearningDocument = (id: string, body: DocumentPatch) =>
  send<LearningDocument>(`/learning/documents/${seg(id)}`, 'PATCH', body);

/** Snapshots the linked wiki page as the next version. */
export const publishLearningDocument = (id: string, changeNote?: string) =>
  send<LearningVersion>(`/learning/documents/${seg(id)}/publish`, 'POST',
    changeNote === undefined ? {} : { change_note: changeNote });

export const getLearningVersion = (documentId: string, versionId: string) =>
  get<LearningVersion>(`/learning/documents/${seg(documentId)}/versions/${seg(versionId)}`);

export const archiveLearningDocument = (id: string) =>
  send<void>(`/learning/documents/${seg(id)}`, 'DELETE');

export interface DocumentSignoff {
  id: string; person: PersonRef; version_no: number; language: string; signed_at: string;
  read_seconds: number; quiz_score: number | null;
  initiative_id: string | null; initiative: string | null;
}

export interface DocumentSignoffPage {
  /** Rows matching the version filter. */
  total: number;
  /** Version id → its sign-off count (the whole document, never filtered). */
  version_counts: Record<string, number>;
  items: DocumentSignoff[];
}

/** A page of a document's sign-offs, newest first (offset paging). */
export const listDocumentSignoffs = (
  documentId: string,
  opts: { limit?: number; offset?: number; versionId?: string } = {},
) => get<DocumentSignoffPage>(withQuery(`/learning/documents/${seg(documentId)}/signoffs`, {
  limit: opts.limit === undefined ? undefined : String(opts.limit),
  offset: opts.offset === undefined ? undefined : String(opts.offset),
  version_id: opts.versionId,
}));

export const listLearningWikiPages = () => get<WikiPageOption[]>('/learning/wiki-pages');

// ── packets ──────────────────────────────────────────────────────────

export interface PacketFields {
  name: string;
  description: string | null;
  enforce_order: boolean;
  /** Null = the initiative's schedule. */
  due_offset_days: number | null;
  icon: string | null;
  color: string | null;
}

export interface PacketListItem extends PacketFields {
  id: string; item_count: number; rule_count: number; archived_at: string | null;
}

export interface PacketItem {
  document_id: string; title: string; current_version_no: number | null; archived: boolean;
}

export interface LearningPacket extends PacketFields {
  id: string; items: PacketItem[]; archived_at: string | null;
  created_at: string; updated_at: string;
}

/** `items` are document ids, in order. */
export type PacketCreate = Partial<PacketFields> & { name: string; items?: string[] };
/** Only the keys sent change; `items`, when sent, replaces the list. */
export type PacketPatch = Partial<PacketFields> & { items?: string[] };

export const listLearningPackets = (includeArchived = false) =>
  get<PacketListItem[]>(withQuery('/learning/packets',
    { include_archived: includeArchived ? 'true' : undefined }));

export const createLearningPacket = (body: PacketCreate) =>
  send<LearningPacket>('/learning/packets', 'POST', body);

export const getLearningPacket = (id: string) =>
  get<LearningPacket>(`/learning/packets/${seg(id)}`);

export const patchLearningPacket = (id: string, body: PacketPatch) =>
  send<LearningPacket>(`/learning/packets/${seg(id)}`, 'PATCH', body);

export const copyLearningPacket = (id: string) =>
  send<LearningPacket>(`/learning/packets/${seg(id)}/copy`, 'POST');

export const archiveLearningPacket = (id: string) =>
  send<void>(`/learning/packets/${seg(id)}`, 'DELETE');

// ── assignment rules ─────────────────────────────────────────────────

export interface RuleCondition { field: string; values: string[] }

export interface LearningRule {
  id: string; name: string; packet_id: string; packet_name: string; packet_archived: boolean;
  conditions: RuleCondition[]; position: number; enabled: boolean;
  created_at: string; updated_at: string;
}

export interface RuleCreate {
  name: string; packet_id: string; conditions: RuleCondition[]; enabled?: boolean;
}
export type RulePatch = Partial<RuleCreate>;

export const listLearningRules = () => get<LearningRule[]>('/learning/rules');

export const createLearningRule = (body: RuleCreate) =>
  send<LearningRule>('/learning/rules', 'POST', body);

export const patchLearningRule = (id: string, body: RulePatch) =>
  send<LearningRule>(`/learning/rules/${seg(id)}`, 'PATCH', body);

export const deleteLearningRule = (id: string) =>
  send<void>(`/learning/rules/${seg(id)}`, 'DELETE');

/** Returns the rules in their new order. */
export const reorderLearningRules = (ids: string[]) =>
  send<LearningRule[]>('/learning/rules/reorder', 'POST', { ids });

// ── assignments ──────────────────────────────────────────────────────

export interface SkippedItem { title: string; reason: string }

export interface AssignSummaryRow {
  person_id: string;
  name: string;
  will_get: string[];
  /** One reason per `will_get` entry. */
  why: string[];
  skipped: SkippedItem[];
  no_email: boolean;
}

export interface AssignSummary {
  rows: AssignSummaryRow[];
  totals: { checked: number; to_assign: number; skipped: number; no_email: number };
}

/** The per-initiative dry run; `apply` commits it (needs learning:add). */
export const dryRunInitiative = (initiativeId: string, apply = false) =>
  send<AssignSummary>(`/learning/initiatives/${seg(initiativeId)}/dry-run`, 'POST', { apply });

/** Manual assignment: a packet, listed documents, or both. */
export interface AssignRequest {
  person_ids: string[];
  initiative_id?: string | null;
  packet_id?: string | null;
  document_ids?: string[];
}
export const assignLearning = (body: AssignRequest) =>
  send<AssignSummary>('/learning/assign', 'POST', body);

/** Hands a document's new version to people outside an initiative. */
export const pushLearningVersion = (documentId: string, personIds: string[]) =>
  send<AssignSummary>(`/learning/documents/${seg(documentId)}/push-version`, 'POST',
    { person_ids: personIds });

// ── an initiative's Learning tab ─────────────────────────────────────

export interface ScheduleOut {
  mode: 'manual' | 'scheduled';
  send_offset_days: number;
  /** HH:MM. */
  send_time: string;
  reminder_offsets: number[];
  due_offset_days: number;
  late_adds: boolean;
  sent_at: string | null;
  /** When a scheduled send will go out (or would, for a manual schedule). */
  send_at: string | null;
  codes_expire_on: string | null;
  /** The initiative's local end day is before today: no invites can be sent for it. */
  ended: boolean;
  /** Archived, cancelled or completed: no invites or reminders go out. */
  inactive: boolean;
  /** No schedule saved yet: these are the learning settings' defaults. */
  is_default: boolean;
}

/** Partial update; nothing may be null. */
export type ScheduleIn = Partial<Pick<ScheduleOut,
  'mode' | 'send_offset_days' | 'send_time' | 'reminder_offsets' | 'due_offset_days' | 'late_adds'>>;

export interface InitiativeLearning {
  stats: { invited: number; opened: number; in_progress: number; complete: number; overdue: number };
  schedule: ScheduleOut;
  packets: {
    packet: { id: string; name: string; documents: string[] };
    rule_name: string | null;
    every_initiative: boolean;
  }[];
  extras: { title: string; people: number }[];
  timeline: { date: string; kind: 'invite' | 'reminder' | 'due' | 'start' }[];
}

export interface SendInvitesResult {
  sent: number; no_email: number; skipped_complete: number;
  /** A full send leaves people with a working, emailed code alone. */
  already_invited: number;
}

export type RosterStatus = 'nothing_assigned' | 'complete' | 'in_progress' | 'overdue' | 'not_opened'
  | 'no_email';

export interface RosterRow {
  person_id: string; name: string; email: string | null; partner: string | null;
  language: string; done: number; total: number; status: RosterStatus;
  last_activity: string | null;
}

export type GridState = 'valid' | 'expires_during' | 'missing' | 'not_required';

export interface ComplianceGrid {
  documents: { id: string; title: string }[];
  rows: {
    person_id: string; name: string;
    /** Keyed by document id. */
    cells: Record<string, { state: GridState; label: string }>;
  }[];
}

export const getInitiativeLearning = (initiativeId: string) =>
  get<InitiativeLearning>(`/learning/initiatives/${seg(initiativeId)}`);

export const putInitiativeSchedule = (initiativeId: string, body: ScheduleIn) =>
  send<ScheduleOut>(`/learning/initiatives/${seg(initiativeId)}/schedule`, 'PUT', body);

/** No `personIds`: everyone with open assignments. With them: Resend. */
export const sendInitiativeInvites = (initiativeId: string, personIds?: string[]) =>
  send<SendInvitesResult>(`/learning/initiatives/${seg(initiativeId)}/send`, 'POST',
    personIds === undefined ? {} : { person_ids: personIds });

export interface RemindResult {
  sent: number; no_email: number;
  /** No working code: a reminder doesn't invite them (Send now / Resend do). */
  no_code: number; skipped_complete: number;
}

/** The reminder email now, for the people's current codes (a new link, the
 *  same code: nobody is signed out). No `personIds`: everyone with open
 *  assignments. */
export const remindInitiative = (initiativeId: string, personIds?: string[]) =>
  send<RemindResult>(`/learning/initiatives/${seg(initiativeId)}/remind`, 'POST',
    personIds === undefined ? {} : { person_ids: personIds });

export const listInitiativeRoster = (initiativeId: string, status?: RosterStatus) =>
  get<RosterRow[]>(withQuery(`/learning/initiatives/${seg(initiativeId)}/roster`, { status }));

/** A new code (the old one stops working), emailed. 422 `no_email` when the
 *  person has none — print a code sheet for them instead. */
export const regenerateLearningCode = (initiativeId: string, personId: string) =>
  send<{ sent: boolean }>(
    `/learning/initiatives/${seg(initiativeId)}/people/${seg(personId)}/regenerate`, 'POST');

export const revokeLearningCodes = (initiativeId: string, personId: string) =>
  send<{ revoked: number }>(
    `/learning/initiatives/${seg(initiativeId)}/people/${seg(personId)}/revoke`, 'POST');

/** Fresh codes, printed, for people with open assignments and no email (with
 *  `everyone`, all of them with open assignments). Each replaces the
 *  person's earlier code, so it is a POST. */
export const downloadCodeSheet = (initiativeId: string, everyone = false) =>
  downloadAttachment(
    withQuery(`/learning/initiatives/${seg(initiativeId)}/code-sheet.pdf`,
      { all: everyone ? '1' : undefined }),
    'learning-codes.pdf', { method: 'POST' });

export const getInitiativeGrid = (initiativeId: string) =>
  get<ComplianceGrid>(`/learning/initiatives/${seg(initiativeId)}/grid`);

// ── translations ─────────────────────────────────────────────────────

export interface TranslationStatusRow {
  language: string; status: TranslationStatus; version_no: number | null;
  updated_at: string | null; reviewed_by: PersonRef | null;
}

export interface Translation {
  language: string;
  status: TranslationStatus;
  version_no: number;
  current_version_no: number | null;
  title: string;
  content_html: string;
  source: 'claude' | 'manual';
  updated_at: string;
  updated_by: PersonRef | null;
  reviewed_by: PersonRef | null;
  reviewed_at: string | null;
}

const translationPath = (documentId: string, language: string) =>
  `/learning/documents/${seg(documentId)}/translations/${seg(language)}`;

export const listTranslations = (documentId: string) =>
  get<TranslationStatusRow[]>(`/learning/documents/${seg(documentId)}/translations`);

export const getTranslation = (documentId: string, language: string) =>
  get<Translation>(translationPath(documentId, language));

export const saveTranslation = (
  documentId: string, language: string, body: { title: string; content_html: string },
) => send<Translation>(translationPath(documentId, language), 'PUT', body);

/** A Claude draft of the current version (503 `translation_unavailable`,
 *  502 `translation_failed`). */
export const draftTranslation = (documentId: string, language: string) =>
  send<Translation>(`${translationPath(documentId, language)}/draft`, 'POST');

export const submitTranslation = (documentId: string, language: string) =>
  send<Translation>(`${translationPath(documentId, language)}/submit`, 'POST');

export const approveTranslation = (documentId: string, language: string) =>
  send<Translation>(`${translationPath(documentId, language)}/approve`, 'POST');

// ── quiz questions ───────────────────────────────────────────────────

export interface QuizChoice { id: string; text: string }

export interface QuestionTranslation { prompt?: string; choices?: Record<string, string> }

export interface QuizQuestion {
  id: string;
  document_id: string;
  prompt: string;
  choices: QuizChoice[];
  correct_choice_ids: string[];
  /** Language → { prompt?, choices? }; what's missing falls back to English. */
  translations: Record<string, QuestionTranslation>;
  position: number;
  created_at: string;
}

export interface QuestionCreate {
  prompt: string;
  /** New choices get an id from the server. */
  choices: { id?: string; text: string }[];
  correct_choice_ids: string[];
  translations?: Record<string, QuestionTranslation>;
}
export type QuestionPatch = Partial<QuestionCreate>;

export const listQuestions = (documentId: string) =>
  get<QuizQuestion[]>(`/learning/documents/${seg(documentId)}/questions`);

export const createQuestion = (documentId: string, body: QuestionCreate) =>
  send<QuizQuestion>(`/learning/documents/${seg(documentId)}/questions`, 'POST', body);

export const reorderQuestions = (documentId: string, ids: string[]) =>
  send<QuizQuestion[]>(`/learning/documents/${seg(documentId)}/questions/reorder`, 'POST', { ids });

export const patchQuestion = (questionId: string, body: QuestionPatch) =>
  send<QuizQuestion>(`/learning/questions/${seg(questionId)}`, 'PATCH', body);

export const deleteQuestion = (questionId: string) =>
  send<void>(`/learning/questions/${seg(questionId)}`, 'DELETE');

/** Forgives a locked worker's failed attempts so they can retry. */
export const unlockQuiz = (assignmentId: string) =>
  send<{ assignment_id: string; attempts_forgiven: number }>(
    `/learning/assignments/${seg(assignmentId)}/unlock-quiz`, 'POST');

// ── dashboard, history, certificates ─────────────────────────────────

/** The ranges the dashboard offers, in days (the API accepts only these). */
export const DASHBOARD_DAYS = [7, 30, 90] as const;
export type DashboardDays = (typeof DASHBOARD_DAYS)[number];

export interface LearningDashboard {
  funnel: {
    assigned: number; opened: number; complete: number;
    median_open_hours: number | null; median_finish_minutes: number | null;
  };
  overrides: { count: number; admins: number };
  at_risk: {
    initiative_id: string; name: string; starts_in_days: number; percent: number;
    not_finished: number; no_email: number;
  }[];
  expiring: { document_id: string; title: string; people: number; first_date: string }[];
  translation_issues: { document_id: string; title: string; language: string }[];
  hard_questions: { question_id: string; document_title: string; miss_percent: number }[];
}

export interface LearningHistory {
  person: { id: string; name: string };
  signoffs: {
    id: string; document_id: string; document: string; version: number; language: string;
    signed_at: string; read_seconds: number; quiz_score: number | null;
    initiative_id: string | null; initiative: string | null;
  }[];
  quiz_attempts: {
    id: string; document_id: string; document: string; score_percent: number; passed: boolean;
    created_at: string; initiative_id: string | null; initiative: string | null;
  }[];
  overrides: {
    id: string; created_at: string; reason: string; reason_text: string | null; scope: string;
    local_day: string; admin: string | null; initiative_id: string | null;
    initiative: string | null;
  }[];
  open_assignments: {
    id: string; document_id: string; document: string; status: string; source: string;
    due_on: string | null; initiative_id: string | null; initiative: string | null;
  }[];
}

export const getLearningDashboard = (days: DashboardDays = 30) =>
  get<LearningDashboard>(withQuery('/learning/dashboard', { days: String(days) }));

/** Open to learning managers and to `workers:view` holders over that worker. */
export const getLearningHistory = (personId: string) =>
  get<LearningHistory>(`/learning/people/${seg(personId)}/history`);

const slug = (name: string) =>
  name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'worker';

/** The person's sign-off certificate (typed names, drawn signatures), for
 *  learning managers only. */
export const downloadCertificate = (personId: string, personName: string, initiativeId?: string) =>
  downloadAttachment(
    withQuery(`/learning/people/${seg(personId)}/certificate.pdf`, { initiative_id: initiativeId }),
    `learning-certificate-${slug(personName)}.pdf`);

// ── settings (/system/learning) ──────────────────────────────────────

export interface LearningEmailText { subject: string; intro: string }

export interface LearningSettings {
  code_max_failures: number;
  code_lockout_seconds: number;
  ip_limit: number;
  ip_window_seconds: number;
  global_limit: number;
  /** Null = general codes are off. */
  general_code_days: number | null;
  default_validity_days: number | null;
  invite_offset_days: number;
  /** HH:MM. */
  invite_time: string;
  reminder_offsets: number[];
  due_offset_days: number;
  /** Null = keep sign-offs forever. */
  retention_days: number | null;
  brand_line: string;
  /** Email kind → language → text. */
  email_text: Record<string, Record<string, LearningEmailText>>;
  languages: string[];
}

/** Partial update: only sent fields change. The three nullable numbers
 *  accept an explicit null (the rule is off); nothing else does. */
export type LearningSettingsPatch = Partial<LearningSettings>;

export const getLearningSettings = () => get<LearningSettings>('/system/learning');

export const putLearningSettings = (patch: LearningSettingsPatch) =>
  send<LearningSettings>('/system/learning', 'PUT', patch);

// ── compliance report ────────────────────────────────────────────────

/** Queues the Learning compliance report (the definition's default format)
 *  and asks to be notified when it's ready — the same flow as the Generate
 *  report modal. Without an initiative it covers everyone; with one, just
 *  that initiative's workers. */
export async function exportLearningCompliance(initiativeId: string | null = null): Promise<ReportRun> {
  const definitions = await listReportDefinitions();
  const definition = definitions.find((d) => d.report_type === 'learning_compliance');
  if (!definition) throw new Error('learning_report_missing');
  return createReportRun({
    definition_id: definition.id, initiative_id: initiativeId, options: {}, notify: true,
  });
}

// ── display helpers ──────────────────────────────────────────────────

/** "30 min" under an hour, else hours to one decimal ("6 h", "6.4 h"). */
export function formatMedianHours(hours: number | null): string | null {
  if (hours === null) return null;
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  const rounded = hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10;
  return `${rounded} h`;
}

/** "Starts in 3 days", "Starts today", "Started 2 days ago". */
export function startsInText(days: number): string {
  const n = Math.abs(days);
  const unit = n === 1 ? 'day' : 'days';
  if (days === 0) return 'Starts today';
  return days > 0 ? `Starts in ${n} ${unit}` : `Started ${n} ${unit} ago`;
}
