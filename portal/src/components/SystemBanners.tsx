/** Slim console-wide bars: read-only maintenance mode (amber) first, then
 *  the broadcast banner (blue). Rendered in the shell above the topbar
 *  and on the login page above the form. */
import { useSystemStatus } from '../lib/systemStatusContext';

export default function SystemBanners() {
  const { status } = useSystemStatus();
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
