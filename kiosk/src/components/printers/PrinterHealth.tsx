/**
 * Ported verbatim from portal/src/components/printers/PrinterHealth.tsx
 * (only the zebraUsb import moves to @portal — the parsers are shared).
 *
 * Identity + health chips for the connected Zebra printer, read from `~HI`
 * and `~HS` (parsed in labels/zebraUsb.ts). Shared by the printer
 * card and the setup wizard's Identify step. `healthChips` is pure.
 */
import type { HostIdentification, HostStatus } from '@portal/labels/zebraUsb';

export type ChipTone = 'c-green' | 'c-red' | 'c-amber' | 'c-slate';

export function healthChips(status: HostStatus | null): { label: string; tone: ChipTone }[] {
  if (!status) return [];
  const chips: { label: string; tone: ChipTone }[] = [];
  if (status.paperOut) chips.push({ label: 'Paper out', tone: 'c-red' });
  if (status.headOpen) chips.push({ label: 'Head open', tone: 'c-red' });
  if (status.paused) chips.push({ label: 'Paused', tone: 'c-amber' });
  if (status.ribbonOut) chips.push({ label: 'Ribbon out', tone: 'c-red' });
  if (status.overTemp) chips.push({ label: 'Over temperature', tone: 'c-red' });
  if (status.underTemp) chips.push({ label: 'Under temperature', tone: 'c-amber' });
  if (status.bufferFull) chips.push({ label: 'Buffer full', tone: 'c-amber' });
  if (chips.length === 0) chips.push({ label: 'Ready', tone: 'c-green' });
  if (status.formatsQueued > 0) {
    chips.push({ label: `${status.formatsQueued} label${status.formatsQueued === 1 ? '' : 's'} queued`, tone: 'c-slate' });
  }
  return chips;
}

export default function PrinterHealth({ identity, status, productName }: {
  identity: HostIdentification | null; status: HostStatus | null; productName: string | null;
}) {
  return (
    <div className="zp-chips" aria-label="Printer identity and health">
      {identity ? (
        <>
          <span className="chip tag" title="Model">{identity.model}</span>
          <span className="chip tag" title="Firmware">{identity.firmware}</span>
          <span className="chip tag" title="Resolution">{identity.dpi} DPI</span>
          <span className="chip tag" title="Memory">{identity.memory}</span>
        </>
      ) : productName ? <span className="chip tag">{productName}</span> : null}
      {healthChips(status).map((c) => (
        <span key={c.label} className={`chip ${c.tone}`}><span className="dot" />{c.label}</span>
      ))}
    </div>
  );
}
