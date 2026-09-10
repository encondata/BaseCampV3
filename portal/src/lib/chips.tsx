/**
 * One status/vocabulary chip renderer for the whole app. Every page used
 * to hand-roll its own `chip(label, color)` — nine near-identical copies
 * across Initiatives.tsx, SiteDetail.tsx, InitiativeDetail.tsx (x2),
 * WorkerDetail.tsx, StakeholderDetail.tsx, AssetDetail.tsx, ClientDashboard.tsx
 * and MoveAssetDetail.tsx — and several of them rendered NOTHING (`null`,
 * or the wrong "—" placeholder that discarded the label) whenever the
 * vocabulary value carried no color, silently blanking an otherwise-valid
 * cell. `statusChip` is the single source of truth: a value with a stored
 * color renders as a colored `chip custom`; a value with no color still
 * renders — as a neutral `chip tag`, per the semantic rule above
 * `.mini-row` in directory.css ("chip tag when it's a neutral kind with no
 * color of its own") — so the label is never lost. Only a genuinely
 * missing/empty label renders nothing, since there's no chip to show.
 */
import type { CSSProperties, ReactElement } from 'react';

export function statusChip(
  label: string | null | undefined,
  color: string | null | undefined,
): ReactElement | null {
  if (!label) return null;
  if (!color) return <span className="chip tag">{label}</span>;
  return (
    <span className="chip custom" style={{ '--chip': color } as CSSProperties}>
      <span className="dot" />{label}
    </span>
  );
}
