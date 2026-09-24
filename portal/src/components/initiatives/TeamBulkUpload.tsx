/**
 * TeamBulkUpload — stub. Task 4 replaces this with the real upload pane
 * (file drop, per-line worker/site/role matching, apply summary).
 */
export default function TeamBulkUpload({ jobId }: { jobId: string }) {
  return <div className="bulk-import" data-job={jobId} />;
}
