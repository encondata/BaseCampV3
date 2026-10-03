/** Small shared pieces of the Deployments dashboard. */
import type { ReactNode } from 'react';

export const SOON = 'Coming later';

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

export type Tone = 'ok' | 'warn' | 'muted' | 'blue';

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`sd-dot is-${tone}`} aria-hidden="true" />;
}

const OK = new Set(['active', 'running', 'healthy', 'available']);
const WARN = new Set(['provisioning', 'degraded']);

export function statusTone(status: string): Tone {
  if (OK.has(status)) return 'ok';
  if (WARN.has(status)) return 'warn';
  return 'muted';
}

export function dotTone(dot: string | null | undefined): Tone | null {
  if (dot === 'green') return 'ok';
  if (dot === 'blue') return 'blue';
  if (dot === 'amber') return 'warn';
  if (dot === 'gray') return 'muted';
  return null;
}
