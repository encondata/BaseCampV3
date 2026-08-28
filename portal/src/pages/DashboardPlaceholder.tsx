/** Placeholder for dashboards that haven't been built yet. */

export default function DashboardPlaceholder({ title }: { title: string }) {
  return (
    <div className="portal-page">
      <div className="eyebrow">Dashboards</div>
      <h1 className="page-title">{title}</h1>
      <p className="page-hint">Nothing here yet — this dashboard is coming soon.</p>
    </div>
  );
}
