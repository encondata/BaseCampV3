/**
 * TwoFactorOffNote — sits beside a "Require 2FA" switch (user page, role
 * card, group card) while the site's two-factor master switch is off. The
 * switch stays usable so it can be set in advance; this says it does
 * nothing yet and links to where it's turned on.
 */
import { Link } from 'react-router-dom';

export default function TwoFactorOffNote() {
  return (
    <span className="set-note totp-off-note">
      Not in effect — two-factor is off in{' '}
      <Link to="/settings/security">System settings › Security</Link>.
    </span>
  );
}
