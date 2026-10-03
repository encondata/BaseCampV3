/**
 * The dark full-screen shell + white card used by screens that render
 * INSTEAD of the portal shell (forced password change, reset password).
 * Defines the theme variables .portal-shell normally provides, so
 * .btn-solid renders as a real button.
 */

import { type CSSProperties, type ReactNode } from 'react';

import '../styles/profile.css';
import '../styles/settings.css';

export default function AuthCard({ title, lead, children }: {
  title: ReactNode; lead?: ReactNode; children: ReactNode;
}) {
  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center',
      background: '#0c1117', padding: 24, boxSizing: 'border-box', width: '100%',
      fontFamily: "'Geologica', sans-serif",
      '--accent': '#ffa12e',
      '--accent-soft': '#ffc06b',
      '--font-display': "'Geologica', sans-serif",
    } as CSSProperties}>
      <div style={{
        width: 'min(480px, 100%)', background: '#fbfcfd', borderRadius: 18,
        padding: '30px 30px 26px', boxShadow: '0 40px 90px -30px rgba(0,0,0,.7)', boxSizing: 'border-box',
      }}>
        <p style={{
          fontFamily: "'Fragment Mono', monospace", fontSize: 10.5,
          letterSpacing: '.3em', textTransform: 'uppercase',
          color: '#ffa12e', margin: 0,
        }}>
          ServerSherpa Portal
        </p>
        <h1 style={{ margin: '10px 0 6px', fontSize: 24, color: '#1b2129' }}>{title}</h1>
        {lead && (
          <p style={{ margin: '0 0 22px', fontSize: 14, color: '#667085', fontWeight: 300 }}>{lead}</p>
        )}
        {children}
      </div>
    </div>
  );
}
