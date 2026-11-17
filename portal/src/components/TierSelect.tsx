/**
 * TierSelect — the owner/admin/viewer contact-tier picker, shared between
 * the org-row ContactsPanel (OrgDirectory.tsx) and the External page so
 * the two full-management surfaces stay visually and behaviorally in sync.
 */

import { useAuth } from '../auth/AuthContext';
import type { ContactTier, OrgKind } from '../lib/api';

export const TIER_LABEL: Record<ContactTier, string> = {
  owner: 'Owner', admin: 'Admin', viewer: 'Viewer', individual: 'Individual',
};

export default function TierSelect({ value, onChange, disabled, kind }: {
  value: ContactTier;
  /** 'client' links may also offer Individual, to global staff only;
   *  partners never do. Omitted = partner-style (no Individual). */
  kind?: OrgKind;
  onChange: (tier: ContactTier) => void;
  disabled?: boolean;
}) {
  const { scope } = useAuth();
  const offerIndividual = (kind === 'client' && scope?.global === true) || value === 'individual';
  return (
    <select className="org-select" style={{ maxWidth: 110 }} value={value} disabled={disabled}
            onChange={(e) => onChange(e.target.value as ContactTier)}>
      <option value="owner">Owner</option>
      <option value="admin">Admin</option>
      <option value="viewer">Viewer</option>
      {offerIndividual && <option value="individual">Individual</option>}
    </select>
  );
}
