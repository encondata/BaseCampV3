/** The finish screen: Open the move, the crate/truck counts, and the From-To
 *  import's per-row summary with its CSV download (BulkApplySummary). */
import { Link } from 'react-router-dom';

import type { MoveSetupDraft } from '../../lib/api';
import { assetSummary, createdCount } from '../../lib/moveSetup';
import BulkApplySummary from '../bulk/BulkApplySummary';

export default function MoveSetupFinish({ draft, moveName }: { draft: MoveSetupDraft; moveName: string }) {
  const results = draft.results ?? {};
  const moveId = results.move_id ?? draft.initiative_id ?? '';
  const assets = results.assets ? assetSummary(results.assets) : null;
  return (
    <section className="bulk-section">
      <p className="eyebrow-sm">Move created</p>
      <div className="bulk-actions">
        <b>{moveName} was created.</b>
        <Link className="btn-solid" to={`/initiatives/${moveId}`}>Open the move</Link>
      </div>
      <p className="set-note">
        {createdCount(results.crates ?? 0, 'crate')} · {createdCount(results.trucks ?? 0, 'truck')}
      </p>
      {assets ? (
        <BulkApplySummary result={assets} entityLabel="Serial"
                          linkFor={(r) => (r.asset_id ? `/assets/${r.asset_id}` : null)}
                          filename="move-setup-assets-summary" openTo={`/initiatives/${moveId}`}
                          openLabel="Open the move" pageSize={200}
                          extraColumn={{ label: 'Message', value: (r) => r.message }} />
      ) : <p className="page-hint">No From-To file was imported.</p>}
    </section>
  );
}
