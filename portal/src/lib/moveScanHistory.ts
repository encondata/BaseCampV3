/**
 * Pure helpers for the Move Scan History generate options
 * (`MoveScanHistoryOptions`), kept side-effect free so the status-column
 * preview and the run payload are unit-testable without mounting the
 * component tree or mocking the API.
 */
import type { ReportDefinition, ScanHistoryPreviewStatus } from './api';

export type ScanHistoryFormat = 'xlsx' | 'pdf';
export type StatusColumnsMode = 'pipeline' | 'all';

/** A preview status flagged for the chip strip: `alsoScanned` marks a
 *  status that isn't in the move-scan-history pipeline but was actually
 *  scanned — pipeline mode still surfaces it (after the pipeline
 *  columns) so nothing scanned is hidden, per the design spec. */
export interface StatusColumnPreview extends ScanHistoryPreviewStatus {
  alsoScanned: boolean;
}

/**
 * The status columns to preview for a given mode, mirroring the API's
 * own column selection (see `move-scan-history-design.md` §"Status
 * columns"): `all` mode is every status the preview endpoint returned,
 * in its own order, none flagged; `pipeline` mode is the in-pipeline
 * statuses first, then any non-pipeline status that was actually
 * scanned (`scan_count > 0`), flagged `alsoScanned` so the UI can show
 * the "also scanned" hint.
 */
export function columnsForMode(
  statuses: ScanHistoryPreviewStatus[], mode: StatusColumnsMode,
): StatusColumnPreview[] {
  if (mode === 'all') return statuses.map((s) => ({ ...s, alsoScanned: false }));
  const pipeline = statuses.filter((s) => s.in_pipeline).map((s) => ({ ...s, alsoScanned: false }));
  const extra = statuses
    .filter((s) => !s.in_pipeline && s.scan_count > 0)
    .map((s) => ({ ...s, alsoScanned: true }));
  return [...pipeline, ...extra];
}

export interface ScanHistoryRunOptions {
  format: ScanHistoryFormat;
  status_columns: StatusColumnsMode;
}

/** Assembles the run's `options` payload. */
export function buildRunOptions(
  format: ScanHistoryFormat, statusColumns: StatusColumnsMode,
): ScanHistoryRunOptions {
  return { format, status_columns: statusColumns };
}

export interface ScanHistoryFormatDefaults {
  format: ScanHistoryFormat;
  statusColumns: StatusColumnsMode;
}

/**
 * Reads the definition's `default_format`/`status_columns` options,
 * falling back to the report's own defaults (xlsx / pipeline) for a
 * value that isn't one of the two recognized strings — the same
 * "unknown → the safe default" rule the API's `validate_options`
 * applies server-side.
 */
export function formatDefaults(
  definition: Pick<ReportDefinition, 'options'>,
): ScanHistoryFormatDefaults {
  return {
    format: definition.options.default_format === 'pdf' ? 'pdf' : 'xlsx',
    statusColumns: definition.options.status_columns === 'all' ? 'all' : 'pipeline',
  };
}
