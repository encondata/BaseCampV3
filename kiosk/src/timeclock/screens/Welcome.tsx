/** Welcome (station only): the greeting and the two ways in. A badge or
 *  QR reader scans at any time into the flow's hidden input; the Scan
 *  card only points at the reader. */

import type { ReactNode } from 'react';

import { IconChevron, IconKeyboard, IconQr } from '../icons';

export const PAUSED_TEXT = 'This time clock is paused. Ask an administrator to sign in here '
  + 'or renew this kiosk on Kiosk Devices.';

export interface WelcomeProps {
  paused: boolean;
  /** "We couldn't find that code." and the like. */
  message: string | null;
  /** The hidden, always-focused input the reader types into. */
  scanInput: ReactNode;
  onScan(): void;
  onName(): void;
}

export default function Welcome({ paused, message, scanInput, onScan, onName }: WelcomeProps) {
  return (
    <section className="tcx-screen tcx-welcome">
      <h1 className="tcx-hero">Welcome!</h1>
      <p className="tcx-lead">Please identify yourself to continue.</p>
      {paused && <p className="tcx-notice" role="status">{PAUSED_TEXT}</p>}
      {message && <p className="tcx-error-text" role="alert">{message}</p>}
      <div className="tcx-cards">
        <button type="button" className="tcx-card" disabled={paused} onClick={onScan}>
          <IconQr className="tcx-card-icon" />
          <span className="tcx-card-text">
            <span className="tcx-card-title">Scan Your QR Code</span>
            <span className="tcx-card-sub">Scan your code with the reader</span>
          </span>
          <IconChevron className="tcx-card-chev" />
        </button>
        <button type="button" className="tcx-card" disabled={paused} onClick={onName}>
          <IconKeyboard className="tcx-card-icon" />
          <span className="tcx-card-text">
            <span className="tcx-card-title">Enter Your Name</span>
            <span className="tcx-card-sub">Type your name on screen</span>
          </span>
          <IconChevron className="tcx-card-chev" />
        </button>
      </div>
      {scanInput}
    </section>
  );
}
