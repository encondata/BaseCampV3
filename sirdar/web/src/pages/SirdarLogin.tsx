import { useEffect, useState } from 'react';

import Login from '@portal/pages/Login';
import { apiUrl } from '@portal/lib/api';

/** Refusals only Sirdar's API returns — the portal's Login falls back to
 *  these before its own generic text. */
export const SIRDAR_ERRORS: Record<string, string> = {
  password_change_required:
    'Your portal password has to be changed first. Update it in the portal, then ask an admin to re-import users.',
  totp_enrollment_required:
    'Two-factor is required for your account. Set it up in the portal, then ask an admin to re-import users.',
};

export default function SirdarLogin() {
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiUrl()}/system/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => { if (!cancelled && s) setNeedsSetup(!!s.needs_setup); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const notice = needsSetup ? (
    <>No users yet. On the Sirdar host run <code>sirdar create-admin</code> or{' '}
      <code>sirdar import-users</code>.</>
  ) : null;

  return (
    <Login eyebrow="Sirdar" sceneTag="Environment Builder" notice={notice}
           extraErrors={SIRDAR_ERRORS}
           recovery="Sirdar uses your ServerSherpa portal password. Reset it from the portal's sign-in page, then ask a Sirdar admin to re-import users." />
  );
}
