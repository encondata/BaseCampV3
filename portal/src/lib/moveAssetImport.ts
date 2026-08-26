/** Pure helpers for the move-assets import page: report shaping, progress
 *  math, and API error mapping. The page stays thin per repo convention. */

import { ApiError, type ImportJobOut, type ImportRowDetail } from './api';

export interface ImportCounts {
  created: number;
  updated: number;
  review: number;
  error: number;
}

export function countDetails(details: ImportRowDetail[]): ImportCounts {
  const counts: ImportCounts = { created: 0, updated: 0, review: 0, error: 0 };
  for (const d of details) counts[d.status] += 1;
  return counts;
}

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
};

// ApiError stores the FastAPI detail code directly on `.code` (api.ts:141,
// `constructor(public status: number, public code: string, ...)`), not
// nested under a `.body`/`.detail` object — same field SiteBulkImport's
// mapError reads (SiteBulkImport.tsx:112: `BULK_ERRORS[err.code]`).
export function importErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    return IMPORT_ERRORS[e.code] ?? 'Something went wrong — try again.';
  }
  return 'Something went wrong — try again.';
}
