/** The Linux laptop's Esc → PIN pad, mounted once at the app root, so it
 *  works on every screen, the sign-in page included. The PIN pad renders in
 *  its own fixed `.portal-shell.kiosk-shell` host on <body>. That gives it the
 *  house tokens and the kiosk's pinned-foot modal rules everywhere, and the
 *  signed-in person's theme when a shell is up (otherwise the system's). */

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { installEscapeToPin } from '../../lib/escapeToPin';
import { lockdownAvailable } from '../../lib/hostHelper';
import PinPadModal from './PinPadModal';

function hostAttrs(): { theme: string; accent: string | undefined } {
  const shell = document.querySelector<HTMLElement>('.portal-shell:not(.kiosk-pin-host)');
  const theme = shell?.getAttribute('data-theme')
    ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  return { theme, accent: shell?.getAttribute('data-accent') ?? undefined };
}

export default function LockdownLayer() {
  const enabled = lockdownAvailable();
  const [open, setOpen] = useState(false);
  useEffect(() => (enabled ? installEscapeToPin(() => setOpen(true)) : undefined), [enabled]);
  const close = useCallback(() => setOpen(false), []);
  if (!enabled || !open) return null;
  const { theme, accent } = hostAttrs();
  return createPortal(
    <div className="portal-shell kiosk-shell kiosk-pin-host" data-theme={theme} data-accent={accent}>
      <PinPadModal onClose={close} />
    </div>,
    document.body,
  );
}
