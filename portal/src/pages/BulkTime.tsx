/**
 * BulkTime — /bulk/time, "Add time punches in bulk": the shared page shell
 * (hint, Columns, Download, Upload) with TimeImportUpload as the upload
 * pane. Template downloads only: this tool adds shifts, and never exports
 * or updates existing time.
 */
import BulkToolPage from '../components/bulk/BulkToolPage';
import TimeImportUpload from '../components/time/TimeImportUpload';
import { downloadTimeImportTemplate } from '../lib/api';
import { TIME_COLUMN_GUIDE, TIME_IMPORT_LIMIT_NOTE } from '../lib/timeImport';

export default function BulkTime() {
  return (
    <BulkToolPage
      title="Add time punches in bulk"
      hint={<>
        Download the template, fill in one row per shift, upload it, and review every shift before adding.
        Workers match by email, phone, or name; jobs and sites match by name and must already exist. Values that do not match can be picked in the preview.
        A time without an offset is read in the row&apos;s site time zone (or the job&apos;s site&apos;s), and in Eastern time when neither has one.
        Shifts are added as pending, for approval on the Timesheet. A shift that is already there is skipped.
      </>}
      guide={TIME_COLUMN_GUIDE}
      limitNote={TIME_IMPORT_LIMIT_NOTE}
      downloads={[
        { key: 't-xlsx', label: 'Template (.xlsx)', run: () => downloadTimeImportTemplate('xlsx') },
        { key: 't-csv', label: 'Template (.csv)', run: () => downloadTimeImportTemplate('csv') },
      ]}
    >
      <TimeImportUpload />
    </BulkToolPage>
  );
}
