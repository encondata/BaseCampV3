/**
 * BulkTrucks — /bulk/trucks: the shared page shell configured for trucks,
 * with TruckBulkUpload as the upload pane.
 */
import BulkToolPage from '../components/bulk/BulkToolPage';
import TruckBulkUpload from '../components/trucks/TruckBulkUpload';
import { downloadTruckExport, downloadTruckTemplate } from '../lib/api';
import { TRUCK_COLUMN_GUIDE } from '../lib/truckBulk';

export default function BulkTrucks() {
  return (
    <BulkToolPage
      title="Add or update trucks in bulk"
      hint={<>
        Download the template or the current fleet, fill it in, upload it, and review every add before applying.
        Rows match existing trucks by name; matched rows are skipped unless you tick Update.
        Moves, sites, and containers are matched by name and must already exist.
      </>}
      guide={TRUCK_COLUMN_GUIDE}
      downloads={[
        { key: 't-xlsx', label: 'Template (.xlsx)', run: () => downloadTruckTemplate('xlsx') },
        { key: 't-csv', label: 'Template (.csv)', run: () => downloadTruckTemplate('csv') },
        { key: 'e-xlsx', label: 'Current trucks (.xlsx)', run: () => downloadTruckExport('xlsx'), accent: true },
        { key: 'e-csv', label: 'Current trucks (.csv)', run: () => downloadTruckExport('csv'), accent: true },
      ]}
    >
      <TruckBulkUpload />
    </BulkToolPage>
  );
}
