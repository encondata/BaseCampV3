/** Read-only mode and broadcast banners on the login page — the same
 *  markup as the portal's SystemBanners, fetched directly because that
 *  component is React and lives behind the portal's status context. */

import { useEffect, useState } from 'react';

import { DEFAULT_SYSTEM_STATUS, getSystemStatus, type SystemStatus } from '../lib/api';

export default function KioskBanners() {
  const [status, setStatus] = useState<SystemStatus>(DEFAULT_SYSTEM_STATUS);
  useEffect(() => {
    let cancelled = false;
    getSystemStatus()
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { /* banners are best-effort */ });
    return () => { cancelled = true; };
  }, []);
  const readOnlyText = status.read_only_message
    ? `Read-only maintenance mode — ${status.read_only_message}`
    : 'Read-only maintenance mode';
  return (
    <>
      {status.read_only && (
        <div className="sys-banner sys-banner-readonly" role="status">{readOnlyText}</div>
      )}
      {status.banner && (
        <div className="sys-banner sys-banner-broadcast" role="status">{status.banner}</div>
      )}
    </>
  );
}
