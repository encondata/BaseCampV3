/**
 * BulkWorkers — /bulk/workers: the shared page shell configured for
 * workers, with WorkerBulkUpload as the upload pane.
 */
import BulkToolPage from '../components/bulk/BulkToolPage';
import WorkerBulkUpload from '../components/workers/WorkerBulkUpload';
import { downloadWorkerExport, downloadWorkerTemplate } from '../lib/api';
import { WORKER_COLUMN_GUIDE } from '../lib/workerBulk';

export default function BulkWorkers() {
  return (
    <BulkToolPage
      title="Add or update workers in bulk"
      hint={<>
        Download the template or the current list, fill it in, upload it, and review every add before applying.
        Rows match existing people by email, phone, or name; matched rows are skipped unless you tick Update.
        Every imported person gets the worker role. Login accounts are not created here.
      </>}
      guide={WORKER_COLUMN_GUIDE}
      downloads={[
        { key: 't-xlsx', label: 'Template (.xlsx)', run: () => downloadWorkerTemplate('xlsx') },
        { key: 't-csv', label: 'Template (.csv)', run: () => downloadWorkerTemplate('csv') },
        { key: 'e-xlsx', label: 'Current workers (.xlsx)', run: () => downloadWorkerExport('xlsx'), accent: true },
        { key: 'e-csv', label: 'Current workers (.csv)', run: () => downloadWorkerExport('csv'), accent: true },
      ]}
    >
      <WorkerBulkUpload />
    </BulkToolPage>
  );
}
