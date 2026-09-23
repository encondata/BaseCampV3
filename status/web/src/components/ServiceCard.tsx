import { formatClock, formatUptime, type ServiceSummary } from '../lib/summary';
import UptimeStrip from './UptimeStrip';

const STATE_WORD = { up: 'Operational', down: 'Down', unknown: 'Checking' } as const;

export default function ServiceCard({ service }: { service: ServiceSummary }) {
  const s = service;
  return (
    <section className="panel ss-card" aria-labelledby={`svc-${s.key}`}>
      <div className="panel-head">
        <div className="ss-card-title">
          <span className={`ss-dot ss-dot-${s.state}`} aria-hidden="true" />
          <h2 id={`svc-${s.key}`}>{s.name}</h2>
        </div>
        <span className={`ss-chip ss-chip-${s.state}`}>{STATE_WORD[s.state]}</span>
      </div>
      <div className="panel-body">
        <dl className="ss-stats">
          <div><dt>90-day uptime</dt><dd>{formatUptime(s.uptime_90d)}</dd></div>
          <div><dt>Response time</dt><dd>{s.latency_ms === null ? '—' : `${s.latency_ms} ms`}</dd></div>
          <div><dt>Last checked</dt><dd>{s.last_checked_at ? formatClock(s.last_checked_at) : 'Never'}</dd></div>
        </dl>
        <UptimeStrip days={s.days} />
      </div>
    </section>
  );
}
