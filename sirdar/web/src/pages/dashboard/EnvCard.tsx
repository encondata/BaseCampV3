/** One non-production environment card: a Sirdar environment (Deploy opens
 *  the Deploy modal), or a Dev / Beta / tagged slot with no environment yet
 *  (Set up goes to the Deploy page). Demo cards are inert. */
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import type { DashEnvironment } from '../../lib/sirdarApi';

import { ServerRackIcon } from './icons';
import { Dot, SoonButton } from './parts';

function State({ env }: { env: DashEnvironment }) {
  const version = env.version && <b>{env.version}</b>;
  if (env.state === 'active') {
    return <div className="sd-env-state">{version}<span className="sd-pill is-ok"><Dot tone="ok" />Running</span></div>;
  }
  if (env.state === 'deploying') {
    return <div className="sd-env-state">{version}<span className="sd-pill is-muted"><Dot tone="blue" />Deploying</span></div>;
  }
  if (env.state === 'failed') {
    return <div className="sd-env-state">{version}<span className="sd-pill is-warn"><Dot tone="warn" />Last deploy failed</span></div>;
  }
  return <div className="sd-env-state sd-caps">No active deployment</div>;
}

export default function EnvCard({ env, demo, canDeploy, onDeploy, onSetUp }: {
  env: DashEnvironment; demo: boolean; canDeploy: boolean;
  onDeploy: (name: string) => void; onSetUp: () => void;
}) {
  const { can } = useAuth();
  const headingId = useId();
  const lit = env.state === 'active' || env.state === 'deploying';
  const name = env.environment;
  const released = env.last_release
    ? `Last release: ${env.last_release}${env.last_release_at ? ` · ${new Date(env.last_release_at).toLocaleDateString()}` : ''}`
    : 'No releases yet';

  let action: ReactNode = null;
  if (demo) action = <SoonButton className="sd-btn-outline sd-env-action" title="Demo data">{env.action_label}</SoonButton>;
  else if (canDeploy && name && env.state === 'deploying') {
    action = <SoonButton className="sd-btn-outline sd-env-action" title="A deployment is running.">{env.action_label}</SoonButton>;
  } else if (canDeploy && name) {
    action = <button type="button" className="sd-btn sd-btn-outline sd-env-action" onClick={() => onDeploy(name)}>{env.action_label}</button>;
  } else if (canDeploy) {
    action = <button type="button" className="sd-btn sd-btn-outline sd-env-action" onClick={onSetUp}>{env.action_label}</button>;
  }

  return (
    <section className="sd-card sd-env" aria-labelledby={headingId}>
      <h3 id={headingId}>
        {name && !demo && can('deploy', 'view') ? <Link to={`/deploy/environments/${encodeURIComponent(name)}`}>{env.label}</Link> : env.label}
      </h3>
      {env.sub && <div className="sd-muted">{env.sub}</div>}
      <div className="sd-env-body">
        <div className="sd-slot-icon">
          <ServerRackIcon size={30} />
          <span className={`sd-icon-dot is-${lit ? 'blue' : 'muted'}`} aria-hidden="true" />
        </div>
        <div className="sd-env-main">
          <State env={env} />
          <div className="sd-muted">{released}</div>
        </div>
        {action && <div className="sd-vdivider" aria-hidden="true" />}
        {action}
      </div>
    </section>
  );
}
