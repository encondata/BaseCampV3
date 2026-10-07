/** Step 5: what will route traffic, read-only. */
import DataTable from '@portal/components/DataTable';

import { targetKind, trafficPlan } from '../flowState';

import type { StepProps } from './EnvironmentStep';

export default function TrafficStep({ state, ctx }: StepProps) {
  const plan = trafficPlan(state, ctx);
  const bg = state.servers === 'bluegreen';
  const lan = targetKind(state.target) !== 'digitalocean';
  return (
    <>
      <p className="page-hint">
        {plan.kind === 'load_balancer'
          ? "A DigitalOcean load balancer with a Let's Encrypt certificate sends each name to the live droplet; Sirdar builds it on the first deploy."
          : `Nginx Proxy Manager gets one proxy host per public app, pointed at the first server.${bg
            ? ' Activate moves every proxy host but spaces to the other app VM.' : ''}`}
      </p>
      {lan && !state.publish && (
        <p className="page-hint">
          {bg ? 'DNS records stay as they are; Sirdar still manages the proxy hosts.'
            : 'DNS records and proxy hosts are set up by hand.'}
        </p>
      )}
      <DataTable
        ariaLabel="Traffic plan"
        columns={[{ key: 'host', label: 'Public name', mono: true }, { key: 'via', label: 'Through' },
                  { key: 'to', label: 'To', mono: true }]}
        rows={plan.rows.map((r) => ({ key: r.hostname, cells: [r.hostname, r.via, r.to] }))}
      />
    </>
  );
}
