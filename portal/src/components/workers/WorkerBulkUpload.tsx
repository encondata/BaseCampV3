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

const CONFIG: BulkUploadConfig<WorkerBulkRowResult, WorkerBulkAppliedRow> = {
  idPrefix: 'worker',
  noun: 'worker',
  newLabel: 'new worker',
  errors: WORKER_BULK_ERRORS,
  preview: previewWorkerBulk,
  commit: commitWorkerBulk,
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
