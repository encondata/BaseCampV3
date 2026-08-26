/** Pure helpers for the System Config → Logging tab. */

import { ApiError, type LoggingConfig } from './api';

const LEVELS = new Set(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']);

function intIn(value: number, lo: number, hi: number): boolean {
  return Number.isInteger(value) && value >= lo && value <= hi;
}

export function validateLoggingForm(
  cfg: LoggingConfig,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!intIn(cfg.local_max_rows_per_process, 1000, 1_000_000)) {
    errors.local_max_rows_per_process = 'Enter 1,000–1,000,000 rows.';
  }
  if (!intIn(cfg.remote_buffer_rows, 1000, 1_000_000)) {
    errors.remote_buffer_rows = 'Enter 1,000–1,000,000 rows.';
  }
  if (!intIn(cfg.local_max_age_days, 1, 365)) {
    errors.local_max_age_days = 'Enter 1–365 days.';
  }
  if (!LEVELS.has(cfg.min_level)) {
    errors.min_level = 'Pick a log level.';
  }
  const remote = cfg.mode !== 'local';
  if (remote && cfg.transport === 'loki'
      && !/^https?:\/\//.test(cfg.loki.url)) {
    errors['loki.url'] = 'Enter the Loki base URL (http:// or https://).';
  }
  if (remote && cfg.transport === 'syslog') {
    if (!cfg.syslog.host) errors['syslog.host'] = 'Enter the syslog host.';
    if (!intIn(cfg.syslog.port, 1, 65535)) {
      errors['syslog.port'] = 'Enter a port 1–65535.';
    }
  }
  return errors;
}

export function serverFieldErrors(e: unknown): Record<string, string> {
  if (e instanceof ApiError && e.code === 'invalid_logging_config') {
    const fields = (e.detail as { fields?: Record<string, string> } | null)
      ?.fields;
    if (fields) return fields;
  }
  return {};
}
