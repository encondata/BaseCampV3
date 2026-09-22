/**
 * WorkerBulkUpload — the /bulk/workers upload pane: the shared BulkUpload
 * configured for workers (email / phone / name matching, per-row update or
 * skip, summary linking to each worker's page).
 */
import {
  commitWorkerBulk,
  previewWorkerBulk,
  type WorkerBulkAppliedRow,
  type WorkerBulkCommitResult,
  type WorkerBulkRowResult,
} from '../../lib/api';
import { WORKER_BULK_ERRORS } from '../../lib/workerBulk';
import BulkUpload, { type BulkUploadConfig } from '../bulk/BulkUpload';

// Wrap preview/commit in closures instead of referencing the imports directly:
// tests that stub lib/api with a partial mock still import App, so the api
// functions must not be dereferenced at module load.
const CONFIG: BulkUploadConfig<WorkerBulkRowResult, WorkerBulkAppliedRow> = {
  idPrefix: 'worker',
  noun: 'worker',
  newLabel: 'new worker',
  errors: WORKER_BULK_ERRORS,
  preview: (file, name) => previewWorkerBulk(file, name),
  commit: (rows, approved, source) => commitWorkerBulk(rows, approved, source),
  idOf: (r) => r.person_id,
  summary: {
    entityLabel: 'Worker',
    linkFor: (r) => `/people/workers/${r.person_id}`,
    filename: 'workers-bulk-summary',
    openTo: '/people/workers',
    openLabel: 'Open Workers',
  },
};

export default function WorkerBulkUpload({ onDone }: { onDone?(result: WorkerBulkCommitResult): void }) {
  return <BulkUpload config={CONFIG} onDone={onDone} />;
}
