/**
 * BulkAssets — /bulk/assets: the shared page shell configured for updating
 * existing assets, with AssetBulkUpload as the upload pane.
 */
import BulkToolPage from '../components/bulk/BulkToolPage';
import AssetBulkUpload from '../components/assets/AssetBulkUpload';
import { downloadAssetBulkExport, downloadAssetBulkTemplate } from '../lib/api';
import { ASSET_BULK_COLUMN_GUIDE } from '../lib/assetBulk';

export default function BulkAssets() {
  return (
    <BulkToolPage
      title="Update assets in bulk"
      hint={<>
        Download the template or the current assets, fill in only what should change, upload it,
        and review every change before applying.
        Rows match by Asset ID, or by serial number when the Asset ID is blank; blank cells leave a value alone.
        Make and model, client, site, and status must already exist — unknown or shared values can be
        picked in the preview. Large files apply in the background.
      </>}
      guide={ASSET_BULK_COLUMN_GUIDE}
      downloads={[
        { key: 't-xlsx', label: 'Template (.xlsx)', run: () => downloadAssetBulkTemplate('xlsx') },
        { key: 't-csv', label: 'Template (.csv)', run: () => downloadAssetBulkTemplate('csv') },
        { key: 'e-xlsx', label: 'Current assets (.xlsx)', run: () => downloadAssetBulkExport('xlsx'), accent: true },
        { key: 'e-csv', label: 'Current assets (.csv)', run: () => downloadAssetBulkExport('csv'), accent: true },
      ]}
      limitNote="Uploads are limited to 15,000 rows and 20 MB."
    >
      <AssetBulkUpload />
    </BulkToolPage>
  );
}
