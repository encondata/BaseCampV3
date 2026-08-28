/** Time Management — punch clock, timesheet approvals, and per-initiative
 *  time summaries. Shell only this task: the fetchers exist in lib/api.ts
 *  but the real TimeclockPanel UI lands in the next task. */

export default function TimeManagement() {
  return (
    <div className="portal-page">
      <div className="eyebrow">People</div>
      <h1 className="page-title">Time Management</h1>
      <p className="page-hint">
        Clock in/out, review timesheets, and approve or reject entries.
      </p>
      <p className="page-hint">TimeclockPanel — coming next task.</p>
    </div>
  );
}
