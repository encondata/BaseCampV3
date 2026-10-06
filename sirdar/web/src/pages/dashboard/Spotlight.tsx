/** The selected environment, large: its name, type, state and certificate,
 *  Deploy and Open, and its flow. Activate sits on the idle server box of a
 *  two-slot DigitalOcean environment (deploy:add + deploy:change, only once
 *  that slot has run a deploy, and not while a deployment runs). Demo data
 *  keeps every action inert. */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { DashEnvironment, DashServer } from '../../lib/sirdarApi';
import { slotTitle } from '../environments/labels';

import EnvironmentFlow from './EnvironmentFlow';
import { Dot, SoonButton } from './parts';

function StatePill({ card }: { card: DashEnvironment }) {
  const f = card.flow;
  if (card.state === 'deploying') return <span className="sd-pill is-blue"><Dot tone="blue" />Deploying</span>;
  // A failed deploy or Activate on one slot while another still serves (the
  // environment itself may still read active).
  const live = f.failed_slot ? f.servers.find((s) => s.id === f.active_slot && s.state === 'live') : undefined;
  if (live && live.id !== f.failed_slot) {
    return <span className="sd-pill is-warn"><Dot tone="warn" />{`Failed — ${live.label || slotTitle(live.id)} still live`}</span>;
  }
  if (card.state === 'failed') return <span className="sd-pill is-warn"><Dot tone="warn" />Last deploy failed</span>;
  if (card.state === 'active') return <span className="sd-pill is-ok"><Dot tone="ok" />Running</span>;
  return <span className="sd-pill is-muted"><Dot tone="muted" />{card.environment ? 'Not deployed' : 'Not built yet'}</span>;
}

function CertPill({ card }: { card: DashEnvironment }) {
  const c = card.flow.certificate;
  if (!c) return null;
  const cls = c.tone === 'bad' ? 'is-bad' : c.tone === 'warn' ? 'is-warn' : 'is-ok';
  return <span className={`sd-pill ${cls}`}>{c.tone === 'bad' ? 'Certificate expired' : `Certificate: ${c.days_left} day${c.days_left === 1 ? '' : 's'} left`}</span>;
}

export default function Spotlight({ card, demo, motion, canDeploy, canView, canActivate, onDeploy, onSetUp, onActivate }: {
  card: DashEnvironment; demo: boolean; motion: boolean; canDeploy: boolean; canView: boolean; canActivate: boolean;
  onDeploy: (name: string) => void; onSetUp: () => void; onActivate: (server: DashServer) => void;
}) {
  const name = card.environment;
  const f = card.flow;
  const twoSlots = f.kind === 'load_balancer' && f.servers.length === 2;

  let deploy: ReactNode = null;
  if (demo) deploy = <SoonButton className="sd-btn-outline sd-btn-sm" title="Demo data">Deploy</SoonButton>;
  else if (canDeploy && name && card.state === 'deploying') {
    deploy = <SoonButton className="sd-btn-outline sd-btn-sm" title="A deployment is running.">Deploy</SoonButton>;
  } else if (canDeploy && name) {
    deploy = <button type="button" className="sd-btn sd-btn-primary sd-btn-sm" onClick={() => onDeploy(name)}>Deploy</button>;
  } else if (canDeploy) {
    deploy = <button type="button" className="sd-btn sd-btn-primary sd-btn-sm" onClick={onSetUp}>Set up</button>;
  }
  let open: ReactNode = null;
  if (demo) open = <SoonButton className="sd-btn-outline sd-btn-sm" title="Demo data">Open</SoonButton>;
  else if (name && canView) {
    open = <Link className="sd-btn sd-btn-outline sd-btn-sm" to={`/deploy/environments/${encodeURIComponent(name)}`}>Open</Link>;
  }

  const serverAction = (s: DashServer): ReactNode => {
    if (!twoSlots || s.state !== 'idle' || !s.deployed || f.deploying_slot) return null;
    const label = `Activate ${s.label}`;
    if (demo) return <SoonButton className="sd-btn-outline sd-slot-action" title="Demo data">{label}</SoonButton>;
    if (!canActivate || !name || card.state === 'deploying') return null;
    return <button type="button" className="sd-btn sd-btn-outline sd-slot-action" onClick={() => onActivate(s)}>{label}</button>;
  };

  return (
    <section className="sd-card sd-prod sd-spot" aria-label="Selected environment">
      <header className="sd-card-head sd-spot-head">
        <h2>{card.label}</h2>
        {card.sub && <span className="sd-muted">{card.sub}</span>}
        <StatePill card={card} />
        <CertPill card={card} />
        <span className="sd-spot-actions">{deploy}{open}</span>
      </header>
      <EnvironmentFlow key={card.id} flow={f} motion={motion} serverAction={serverAction} />
    </section>
  );
}
