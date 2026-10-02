/** One non-production environment (Development, Beta or a custom one). */
import { useId } from 'react';

import type { DashEnvironment } from '../../lib/sirdarApi';

import { ServerRackIcon } from './icons';
import { Dot, SoonButton } from './parts';

export default function EnvCard({ env }: { env: DashEnvironment }) {
  const headingId = useId();
  const active = env.state === 'active';
  return (
    <section className="sd-card sd-env" aria-labelledby={headingId}>
      <h3 id={headingId}>{env.label}</h3>
      <div className="sd-env-body">
        <div className="sd-slot-icon">
          <ServerRackIcon size={30} />
          <span className={`sd-icon-dot is-${active ? 'blue' : 'muted'}`} aria-hidden="true" />
        </div>
        <div className="sd-env-main">
          {active ? (
            <div className="sd-env-state">
              {env.version && <b>{env.version}</b>}
              <span className="sd-pill is-ok"><Dot tone="ok" />Running</span>
            </div>
          ) : (
            <div className="sd-env-state sd-caps">No active deployment</div>
          )}
          <div className="sd-muted">
            {env.last_release ? `Last release: ${env.last_release}` : 'No releases yet'}
          </div>
        </div>
        <div className="sd-vdivider" aria-hidden="true" />
        <SoonButton className="sd-btn-outline sd-env-action">{env.action_label}</SoonButton>
      </div>
    </section>
  );
}
