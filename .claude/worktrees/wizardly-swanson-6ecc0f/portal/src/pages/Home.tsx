/** Landing page — intentionally blank for now; elements land here next. */

import { useAuth } from '../auth/AuthContext';

export default function Home() {
  const { mustChangePassword } = useAuth();

  return (
    <div className="portal-page">
      {mustChangePassword && (
        <div className="portal-banner">
          Your password was set by an administrator — please change it once
          password management ships.
        </div>
      )}
      <div className="eyebrow">ServerSherpa Portal</div>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-hint">Nothing here yet — landing page content is coming next.</p>
    </div>
  );
}
