/**
 * BulkSites — /bulk/sites: the shared page shell configured for sites,
 * with SiteBulkUpload as the upload pane.
 */
import BulkToolPage from '../components/bulk/BulkToolPage';
import SiteBulkUpload from '../components/sites/SiteBulkUpload';
import { downloadSiteExport, downloadSiteTemplate } from '../lib/api';
import { SITE_COLUMN_GUIDE } from '../lib/siteBulk';
import '../styles/sites.css';

export default function BulkSites() {
  return (
    <BulkToolPage
      title="Add or update sites in bulk"
      hint={<>
        Download the template or the current list, fill it in, upload it, and review every add and update before applying.
        Rows match existing sites by name or by street address.
      </>}
      guide={SITE_COLUMN_GUIDE}
      downloads={[
        { key: 't-xlsx', label: 'Template (.xlsx)', run: () => downloadSiteTemplate('xlsx') },
        { key: 't-csv', label: 'Template (.csv)', run: () => downloadSiteTemplate('csv') },
        { key: 'e-xlsx', label: 'Current sites (.xlsx)', run: () => downloadSiteExport('xlsx'), accent: true },
        { key: 'e-csv', label: 'Current sites (.csv)', run: () => downloadSiteExport('csv'), accent: true },
      ]}
    >
      <SiteBulkUpload onDone={() => {}} />
    </BulkToolPage>
  );
}
