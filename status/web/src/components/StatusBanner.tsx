import type { Overall, ServiceSummary, Summary } from '../lib/summary';

interface Props {
  overall: Overall;
  services: ServiceSummary[];
  maintenance?: Summary['maintenance'];
}

export default function StatusBanner({ overall, services, maintenance }: Props) {
  const down = services.filter((s) => s.state === 'down').length;
  const text =
    overall === 'operational' ? 'All systems operational'
    : overall === 'degraded' ? `${down} ${down === 1 ? 'service' : 'services'} down`
    : overall === 'maintenance' ? 'Scheduled maintenance'
    : 'Checking services…';
  const tone =
    overall === 'operational' ? 'up'
    : overall === 'degraded' ? 'down'
    : overall === 'maintenance' ? 'maintenance'
    : 'unknown';
  const detail = overall === 'maintenance' ? maintenance?.message : null;
  return (
    <div className={`ss-banner ss-banner-${tone}`} role="status" aria-live="polite">
      <span className={`ss-dot ss-dot-${tone}`} aria-hidden="true" />
      <span className="ss-banner-text">{text}</span>
      {detail && <span className="ss-banner-detail">{detail}</span>}
    </div>
  );
}
