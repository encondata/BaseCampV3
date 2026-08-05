/**
 * TierSelect — the owner/admin/viewer contact-tier picker, shared between
 * the org-row ContactsPanel (OrgDirectory.tsx) and the External page so
 * the two full-management surfaces stay visually and behaviorally in sync.
 */

import type { ContactTier } from '../lib/api';

export const TIER_LABEL: Record<ContactTier, string> = {
  owner: 'Owner', admin: 'Admin', viewer: 'Viewer',
};

export default function TierSelect({ value, onChange, disabled }: {
  value: ContactTier;
  onChange: (tier: ContactTier) => void;
  disabled?: boolean;
}) {
  return (
    <select className="org-select" style={{ maxWidth: 110 }} value={value} disabled={disabled}
            onChange={(e) => onChange(e.target.value as ContactTier)}>
      <option value="owner">Owner</option>
      <option value="admin">Admin</option>
      <option value="viewer">Viewer</option>
    </select>
  );
}
