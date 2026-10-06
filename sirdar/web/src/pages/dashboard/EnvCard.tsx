/** One environment card (Production first). Clicking the card (or Enter /
 *  Space on it) puts it in the spotlight; its small Deploy (or Set up) button
 *  doesn't change the selection. Demo cards' actions are inert. */
import { useId, type ReactNode } from 'react';

import type { DashEnvironment } from '../../lib/sirdarApi';

import { ServerRackIcon } from './icons';
import { Dot, RUNNING, SoonButton, flowStillLive } from './parts';

function State({ env }: { env: DashEnvironment }) {
  const version = env.version && <b>{env.version}</b>;
  const stillLive = flowStillLive(env.flow);
  if (env.state !== 'deploying' && stillLive) {
    return <div className="sd-env-state">{version}<span className="sd-pill is-warn"><Dot tone="warn" />{stillLive}</span></div>;
  }
  if (env.state === 'active') return <div className="sd-env-state">{version}<span className="sd-pill is-ok"><Dot tone="ok" />Running</span></div>;
  if (env.state === 'deploying') return <div className="sd-env-state">{version}<span className="sd-pill is-blue"><Dot tone="blue" />Deploying</span></div>;
  if (env.state === 'failed') return <div className="sd-env-state">{version}<span className="sd-pill is-warn"><Dot tone="warn" />Last deploy failed</span></div>;
  return <div className="sd-env-state sd-caps">{env.environment ? 'No active deployment' : 'Not built yet'}</div>;
}

export default function EnvCard({ env, demo, canDeploy, selected, onSelect, onDeploy, onSetUp }: {
  env: DashEnvironment; demo: boolean; canDeploy: boolean; selected: boolean;
  onSelect: () => void; onDeploy: (name: string) => void; onSetUp: () => void;
}) {
  const headingId = useId();
  const lit = env.state === 'active' || env.state === 'deploying';
  const name = env.environment;
  const released = env.last_release
    ? `Last release: ${env.last_release}${env.last_release_at ? ` · ${new Date(env.last_release_at).toLocaleDateString()}` : ''}`
    : 'No releases yet';
  // demo cards stand for built environments, though they name none
  const short = name || (demo && env.state !== 'empty') ? 'Deploy' : 'Set up';
  const label = `${short} ${env.label}`;

  let action: ReactNode = null;
  if (demo) action = <SoonButton className="sd-btn-outline sd-btn-sm sd-env-action" title="Demo data">{short}</SoonButton>;
  else if (canDeploy && name && (env.state === 'deploying' || env.running)) {
    action = <SoonButton className="sd-btn-outline sd-btn-sm sd-env-action" title={RUNNING}>{short}</SoonButton>;
  } else if (canDeploy) {
    action = (
      <button type="button" className="sd-btn sd-btn-outline sd-btn-sm sd-env-action" aria-label={label}
              onClick={(e) => { e.stopPropagation(); if (name) onDeploy(name); else onSetUp(); }}>{short}</button>
    );
  }

  return (
    <section className={`sd-card sd-env${selected ? ' is-selected' : ''}${env.primary ? ' is-production' : ''}`}
             aria-labelledby={headingId}>
      <button type="button" className="sd-env-select" aria-pressed={selected} aria-label={`Show ${env.label}`}
              onClick={onSelect} />
      <h3 id={headingId}>{env.label}</h3>
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
        {action}
      </div>
    </section>
  );
}
