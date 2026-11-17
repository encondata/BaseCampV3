import { useNavigate } from 'react-router-dom';

import '../styles/bulk.css'; /* .bulk-grid, .bulk-card */
import '../styles/profile.css'; /* .btn-solid */

export default function Dev() {
  const navigate = useNavigate();
  return (
    <div className="portal-page">
      <div className="eyebrow">Developer</div>
      <h1 className="page-title">Developer tools</h1>
      <p className="page-hint">
        Developer tooling lands here. This section is revealed by god mode and
        gated on the developer-only <code>devtools</code> permission.
      </p>

      <div className="bulk-grid">
        <div className="bulk-card">
          <b>Matching rules</b>
          <p className="page-hint">Edit, test and deploy how a scanned or typed value finds its asset.</p>
          <button type="button" className="btn-solid" onClick={() => navigate('/dev/matching-rules')}>
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
