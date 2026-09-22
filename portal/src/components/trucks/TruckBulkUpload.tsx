/**
 * TruckBulkUpload — the /bulk/trucks upload pane: the shared BulkUpload
 * configured for trucks (match by name, per-row update or skip, summary
 * linking to each truck's page).
 */
import {
  commitTruckBulk,
  previewTruckBulk,
  type TruckBulkAppliedRow,
  type TruckBulkCommitResult,
  type TruckBulkRowResult,
} from '../../lib/api';
import { TRUCK_BULK_ERRORS } from '../../lib/truckBulk';
import BulkUpload, { type BulkUploadConfig } from '../bulk/BulkUpload';

const CONFIG: BulkUploadConfig<TruckBulkRowResult, TruckBulkAppliedRow> = {
  idPrefix: 'truck',
  noun: 'truck',
  newLabel: 'new truck',
  errors: TRUCK_BULK_ERRORS,
  preview: previewTruckBulk,
  commit: commitTruckBulk,
  idOf: (r) => r.truck_id,
  summary: {
    entityLabel: 'Truck',
    linkFor: (r) => `/logistics/trucks/${r.truck_id}`,
    filename: 'trucks-bulk-summary',
    openTo: '/logistics/trucks',
    openLabel: 'Open Trucks',
  },
};

export default function TruckBulkUpload({ onDone }: { onDone?(result: TruckBulkCommitResult): void }) {
  return <BulkUpload config={CONFIG} onDone={onDone} />;
}
