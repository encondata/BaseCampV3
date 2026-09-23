import type { Overall, ServiceSummary } from '../lib/summary';

interface Props { overall: Overall; services: ServiceSummary[] }

export default function StatusBanner({ overall, services }: Props) {
  const down = services.filter((s) => s.state === 'down').length;
  const text =
    overall === 'operational' ? 'All systems operational'
    : overall === 'degraded' ? `${down} ${down === 1 ? 'service' : 'services'} down`
    : 'Checking services…';
  const tone = overall === 'operational' ? 'up' : overall === 'degraded' ? 'down' : 'unknown';
  return (
    <div className={`ss-banner ss-banner-${tone}`} role="status" aria-live="polite">
      <span className={`ss-dot ss-dot-${tone}`} aria-hidden="true" />
      <span className="ss-banner-text">{text}</span>
    </div>
  );
}
