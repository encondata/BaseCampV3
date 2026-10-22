/** Verify Your Badge — a placeholder until RFID badge reads land: no tag
 *  is read yet, so Continue moves on. */

import { IconBadgeTap } from '../icons';

export default function VerifyBadge({ onContinue }: { onContinue(): void }) {
  return (
    <section className="tcx-screen tcx-verify">
      <h1 className="tcx-title">Verify Your Badge</h1>
      <p className="tcx-lead">Place your badge against the reader to check it&apos;s working.</p>
      <IconBadgeTap className="tcx-art" />
      <button type="button" className="tcx-btn is-primary" onClick={onContinue}>Continue</button>
    </section>
  );
}
