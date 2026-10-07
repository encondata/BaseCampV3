/** Small shared pieces of the Deployments dashboard. */
import { useId, type ReactNode } from 'react';

import type { DashCert, DashCertHost, DashFlow } from '../../lib/sirdarApi';
import { slotTitle, stillLiveText } from '../environments/labels';

export const SOON = 'Coming later';
export const RUNNING = 'A deployment is running.';

/** "Failed — <live> still live" when a slot's deploy or Activate failed while another slot still serves. */
export function flowStillLive(f: DashFlow): string | null {
  if (!f.failed_slot) return null;
  const live = f.servers.find((s) => s.id === f.active_slot && s.state === 'live');
  return live && live.id !== f.failed_slot ? stillLiveText(live.label || slotTitle(live.id)) : null;
}

/** A button for an action that can't run (not built yet, demo data, or busy):
 *  focusable and titled (a native `disabled` button hides its tooltip), but inert. */
export function SoonButton({ className = '', title = SOON, children }: {
  className?: string; title?: string; children: ReactNode;
}) {
  return (
    <button type="button" className={`sd-btn ${className}`} aria-disabled="true" title={title}
            onClick={(e) => e.preventDefault()}>
      {children}
    </button>
  );
}

const daysText = (n: number) => `${n} day${n === 1 ? '' : 's'} left`;

function hostLine(h: DashCertHost): string {
  if (h.days_left === null || h.expires_at === null) return `${h.hostname} — ${h.error ?? "Couldn't check"}`;
  const expired = h.days_left === 0 && new Date(h.expires_at).getTime() <= Date.now();
  return `${h.hostname} — ${expired ? 'expired' : daysText(h.days_left)}`;
}

/** The certificate pill (spotlight and cards): the soonest expiry among the
 *  environment's public hostnames, amber at 14 days, red once expired, gray
 *  when none could be checked. Its tooltip lists every host; so does its
 *  description, read when the pill takes keyboard focus. */
export function CertPill({ cert, onClick }: { cert: DashCert | null; onClick?: () => void }) {
  const descId = useId();
  if (!cert) return null;
  const lines = cert.hosts.map(hostLine);
  const title = lines.join('\n') || undefined;
  let cls = 'is-ok';
  let text = `Certificate: ${daysText(cert.days_left ?? 0)}`;
  if (cert.tone === 'unknown' || cert.days_left === null) { cls = 'is-muted'; text = "Certificate: couldn't check"; }
  else if (cert.tone === 'bad') { cls = 'is-bad'; text = 'Certificate expired'; }
  else if (cert.tone === 'warn') cls = 'is-warn';
  if (!lines.length) return <span className={`sd-pill sd-cert ${cls}`} onClick={onClick}>{text}</span>;
  return (
    <>
      <span className={`sd-pill sd-cert ${cls}`} title={title} tabIndex={0} aria-describedby={descId}
            onClick={onClick}>{text}</span>
      <span id={descId} hidden>{lines.map((l) => `${l}.`).join(' ')}</span>
    </>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'blue';

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`sd-dot is-${tone}`} aria-hidden="true" />;
}

const OK = new Set(['active', 'running', 'healthy', 'available']);
const WARN = new Set(['provisioning', 'degraded', 'expiring']);
const BAD = new Set(['not_found', 'expired']);

export function statusTone(status: string): Tone {
  if (OK.has(status)) return 'ok';
  if (WARN.has(status)) return 'warn';
  if (BAD.has(status)) return 'bad';
  return 'muted';
}

export function dotTone(dot: string | null | undefined): Tone | null {
  if (dot === 'green') return 'ok';
  if (dot === 'blue') return 'blue';
  if (dot === 'amber') return 'warn';
  if (dot === 'gray') return 'muted';
  return null;
}
