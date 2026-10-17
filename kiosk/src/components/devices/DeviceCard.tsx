/** The shell every Settings › Devices card shares: a title and status pill,
 *  the card's details and notes, and a button row pinned to the bottom of
 *  the card so buttons on side-by-side cards line up (`margin-top: auto` in
 *  a flex column, see `.device-card` in kiosk.css). */

import type { ReactNode } from 'react';

export type PillTone = 'green' | 'red' | 'amber' | 'slate';

export interface DevicePill {
  label: string;
  tone: PillTone;
}

export default function DeviceCard({ title, pill, children, actions, wide = false }: {
  title: string;
  /** null shows no pill (e.g. the reader card off a laptop). */
  pill: DevicePill | null;
  children: ReactNode;
  /** The bottom-pinned button row; omitted renders no row. */
  actions?: ReactNode;
  /** Span the full width of the Devices grid. */
  wide?: boolean;
}) {
  return (
    <section className={`device-card${wide ? ' is-wide' : ''}`} aria-label={title}>
      <div className="device-card-head">
        <h3 className="device-card-title">{title}</h3>
        {pill && (
          <span className={`chip c-${pill.tone}`}><span className="dot" />{pill.label}</span>
        )}
      </div>
      {children}
      {actions && <div className="device-card-actions">{actions}</div>}
    </section>
  );
}
