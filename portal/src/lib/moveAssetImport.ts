/** Pure helpers for the move-assets import page: report shaping, progress
 *  math, and API error mapping. The page stays thin per repo convention. */

import { compareOrdinal } from './naturalSort';
import {
  ApiError, type ClientChoice, type ImportJobOut, type ImportRowDetail, type StoredClientChoice,
} from './api';

export interface ImportCounts {
  created: number;
  updated: number;
  review: number;
  error: number;
  conflict: number;
  skipped: number;
}

export function countDetails(details: ImportRowDetail[]): ImportCounts {
  const counts: ImportCounts = {
    created: 0, updated: 0, review: 0, error: 0, conflict: 0, skipped: 0,
  };
  for (const d of details) counts[d.status] += 1;
  return counts;
}

/** The distinct (lower-cased) serials the check flagged as belonging to
 *  another client — one choice covers every row that repeats a serial. */
export function conflictSerials(details: ImportRowDetail[]): string[] {
  const seen = new Set<string>();
  for (const d of details) {
    if (d.status === 'conflict' && d.serial_number) seen.add(d.serial_number.toLowerCase());
  }
  return [...seen];
}

/** A stable string for a choice map, to tell whether what was saved is what
 *  is on screen. */
export function choicesKey(choices: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(choices).sort(([a], [b]) => compareOrdinal(a, b)));
}

/** serial → choice from the API's stored map (each entry also names the
 *  owner the check saw, which the screen does not need). */
export function choiceMap(
  stored: Record<string, StoredClientChoice | ClientChoice> | null | undefined,
): Record<string, ClientChoice> {
  const out: Record<string, ClientChoice> = {};
  for (const [serial, v] of Object.entries(stored ?? {})) {
    const choice = typeof v === 'string' ? v : v?.choice;
    if (choice === 'continue' || choice === 'skip') out[serial] = choice;
  }
  return out;
}

/** The move's client a check ran against: the wizard stamps it on the
 *  job's options; otherwise the check's summary names it. */
export function checkClientId(job: ImportJobOut): string | null {
  if (job.options && 'client_id' in job.options) return job.options.client_id ?? null;
  const v = (job.results?.summary as Record<string, unknown> | undefined)?.client_id;
  return typeof v === 'string' ? v : null;
}

export const CHOICES_HINT = 'Choose Continue or Skip for every flagged row before importing.';

export function jobIsActive(job: ImportJobOut): boolean {
  return job.status === 'queued' || job.status === 'running';
}

export function jobProgressPct(job: ImportJobOut): number {
  if (job.total_rows <= 0) return 0;
  return Math.min(100,
    Math.round((job.processed_rows / job.total_rows) * 100));
}

export interface SpeedSample {
  at: number;         // Date.now() when sampled
  processed: number;  // job.processed_rows at that moment
}

/** Average rows/second over consecutive sample deltas (v2-style). */
export function rowsPerSecond(samples: SpeedSample[]): number {
  if (samples.length < 2) return 0;
  const rates: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dt = (samples[i].at - samples[i - 1].at) / 1000;
    if (dt > 0) rates.push((samples[i].processed - samples[i - 1].processed) / dt);
  }
  if (rates.length === 0) return 0;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}

export function etaSeconds(job: ImportJobOut, speed: number): number | null {
  if (speed <= 0) return null;
  const remaining = Math.max(0, job.total_rows - job.processed_rows);
  return Math.ceil(remaining / speed);
}

export const IMPORT_ERRORS: Record<string, string> = {
  not_a_move: 'This initiative is not a move — imports only apply to moves.',
  invalid_make_model_mode: 'Unknown make/model mode.',
  unsupported_file: 'Unsupported file type — upload a .csv or .xlsx file.',
  file_too_large: 'File is too large (20 MB max).',
  empty_file: 'The uploaded file is empty.',
  missing_serial_column: 'The file has no Serial Number column.',
  invalid_csv: 'The file could not be read as CSV.',
  invalid_xlsx: 'The file could not be read as a spreadsheet.',
  file_unreadable: 'The stored file could not be read back — upload again.',
  import_job_not_found: 'Import job not found.',
  job_not_ready: 'Validation must finish before the import can run.',
  job_already_finished: 'This import has already finished.',
  unknown_format: 'Unknown template format.',
  no_review_rows: 'Nothing is flagged for review.',
  client_choices_required: 'Choose Continue or Skip for every flagged row before importing.',
  invalid_client_choice: 'Each flagged row needs Continue or Skip.',
  check_stale_client: "The move's client changed after the file was checked. Check the file again.",
  check_only: 'This file check belongs to a move setup. Its rows are imported when the move is created.',
};

// ApiError stores the FastAPI detail code directly on `.code` (api.ts:141,
// `constructor(public status: number, public code: string, ...)`), not
// nested under a `.body`/`.detail` object — same field SiteBulkUpload's
// mapError reads (`SITE_BULK_ERRORS[err.code]` in SiteBulkUpload.tsx).
export function importErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    return IMPORT_ERRORS[e.code] ?? 'Something went wrong — try again.';
  }
  return 'Something went wrong — try again.';
}

// ── review-row make/model helpers ────────────────────────────────────
// Rows the worker flags for review carry the unmatched make/model text
// either as a structured field or embedded in the row's message; these
// helpers surface that text and suggest a make/model split for the fix.

const REVIEW_RE = /Make\/Model '(.+)' not found/;

export function reviewMakeModel(d: ImportRowDetail): string | null {
  if (d.make_model) return d.make_model;
  const m = d.message?.match(REVIEW_RE);
  return m ? m[1] : null;
}

export function suggestSplit(text: string): { make: string; model: string } {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length === 1) return { make: tokens[0], model: tokens[0] };
  let drops = 0;
  while (tokens.length > 2 && drops < 2
         && tokens[0].toLowerCase() === tokens[1].toLowerCase()) {
    tokens.splice(1, 1);
    drops += 1;
  }
  return { make: tokens[0], model: tokens.slice(1).join(' ') };
}

export function missingMakeModels(details: ImportRowDetail[]) {
  const groups = new Map<string, { text: string; rows: number[];
    make: string; model: string }>();
  for (const d of details) {
    if (d.status !== 'review') continue;
    const text = reviewMakeModel(d);
    if (!text) continue;
    const key = text.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(d.row);
    } else {
      const split = d.suggested_make && d.suggested_model
        ? { make: d.suggested_make, model: d.suggested_model }
        : suggestSplit(text);
      groups.set(key, { text, rows: [d.row], ...split });
    }
  }
  return [...groups.values()].map((g) => ({ ...g, rows: [...g.rows].sort((a, b) => a - b) }));
}
