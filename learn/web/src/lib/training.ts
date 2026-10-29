/** The signed-in worker's calls: their training and history, one assignment to read,
 *  its quiz and the sign-off. All go through `learnFetch`; a failure is an
 *  ApiError (status + detail.code), a network failure code `network`. */
import { ApiError } from '@portal/lib/api';

import { learnFetch } from './session';

export interface TrainingItem {
  assignment_id: string;
  title: string;
  status: 'assigned' | 'opened' | 'signed';
  minutes: number;
  has_quiz: boolean;
  locked: boolean;
  signed_at: string | null;
}

export interface TrainingGroup {
  initiative: { id: string; name: string; start: string | null } | null;
  due_on: string | null;
  items: TrainingItem[];
}

export interface Training {
  groups: TrainingGroup[];
  complete: boolean;
  badge_uid: string | null;
}

export interface AssignmentRead {
  title: string;
  html: string;
  language: string;
  fallback: boolean;
  version_no: number;
  change_note: string | null;
  sign_style: 'checkbox' | 'typed_name' | 'drawn_signature';
  require_scroll: boolean;
  min_read_seconds: number | null;
  has_quiz: boolean;
  quiz_passed: boolean;
  /** Set once signed: the document is then read-only, at the version signed. */
  signed_at: string | null;
}

/** One sign-off in the worker's history, newest first. */
export interface HistoryItem {
  assignment_id: string;
  title: string;
  version_no: number;
  initiative: { id: string; name: string } | null;
  signed_at: string;
  language: string;
  /** A newer version of the document was published since. */
  newer_version: boolean;
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  choices: { id: string; text: string }[];
  multiple: boolean;
}

export interface QuizResult {
  score_percent: number;
  passed: boolean;
  attempts_left: number | null;
  locked: boolean;
}

export interface SignBody {
  agreed: boolean;
  typed_name?: string;
  signature_png_b64?: string;
  language: string;
  scrolled_to_end: boolean;
  /** The version shown; a newer one published meanwhile is a 409. */
  version_no?: number;
}

export interface SignResult {
  signoff_id: string;
  signed_at: string;
  complete: boolean;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response;
  try {
    resp = await learnFetch(path, init);
  } catch {
    throw new ApiError(0, 'network');
  }
  if (!resp.ok) {
    let code = 'unknown_error';
    let detail: unknown;
    try {
      detail = (await resp.json())?.detail;
      const c = (detail as { code?: unknown } | undefined)?.code;
      if (typeof c === 'string') code = c;
    } catch { /* non-JSON error body */ }
    throw new ApiError(resp.status, code, detail);
  }
  return resp.json() as Promise<T>;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

const lang = (l: string) => `?lang=${encodeURIComponent(l)}`;
/** An id as one path segment, whatever it holds. */
const seg = (id: string) => encodeURIComponent(id);

export const getTraining = () => call<Training>('/learn/training');

export const getHistory = () => call<HistoryItem[]>('/learn/history');

export const getAssignment = (id: string, l: string) =>
  call<AssignmentRead>(`/learn/assignments/${seg(id)}${lang(l)}`);

export const getQuiz = (id: string, l: string) =>
  call<QuizQuestion[]>(`/learn/assignments/${seg(id)}/quiz${lang(l)}`);

export const submitQuiz = (id: string, answers: Record<string, string[]>) =>
  post<QuizResult>(`/learn/assignments/${seg(id)}/quiz`, { answers });

export const signAssignment = (id: string, body: SignBody) =>
  post<SignResult>(`/learn/assignments/${seg(id)}/sign`, body);
