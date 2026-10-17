/** Settings › Devices › Barcode scanner. Scanners type like a keyboard, so
 *  the kiosk can't see one until it scans: while this card is mounted, a
 *  scan anywhere (a burst of keys under 50 ms apart, ending in Enter) is
 *  caught and shown here. The captured Enter is cancelled before any other
 *  handler sees it, and the burst's characters are taken back out of the
 *  field they landed in, so a scan never types into another field or runs
 *  a kiosk scan action. Human-speed typing is never touched. */

import { ageText, fullDateTime } from '@portal/lib/format';
import { useEffect, useRef, useState } from 'react';

import DeviceCard from './DeviceCard';

/** Keys closer together than this are a scanner, not a person. */
const BURST_GAP_MS = 50;
/** A burst shorter than this is a fast keypress, not a scan. */
const MIN_SCAN_CHARS = 2;
const AGE_TICK_MS = 15_000;

type TextField = HTMLInputElement | HTMLTextAreaElement;

interface Burst {
  chars: string;
  lastAt: number;
  /** The field the burst started in and its value before the first key. */
  field: TextField | null;
  before: string;
  caret: number | null;
}

function textField(target: EventTarget | null): TextField | null {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
}

/** Puts `value` back through the native setter and fires `input`, so a
 *  React-controlled field's state follows. */
function restoreField(field: TextField, value: string, caret: number | null) {
  if (field.value === value) return;
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  if (caret !== null) {
    try { field.setSelectionRange(caret, caret); } catch { /* type without a caret */ }
  }
}

export default function ScannerCard() {
  const [last, setLast] = useState<{ value: string; at: string } | null>(null);
  const [, setTick] = useState(0);
  const burst = useRef<Burst | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A held-down key repeats; a scanner never sends repeats.
      if (e.repeat) return;
      const now = Date.now();
      const b = burst.current;
      const fast = b !== null && now - b.lastAt < BURST_GAP_MS;
      if (e.key === 'Enter') {
        burst.current = null;
        if (!b || !fast || b.chars.length < MIN_SCAN_CHARS) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (b.field) restoreField(b.field, b.before, b.caret);
        setLast({ value: b.chars, at: new Date(now).toISOString() });
        return;
      }
      // Shift and other non-character keys neither count nor break a burst.
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (b && fast) {
        b.chars += e.key;
        b.lastAt = now;
        return;
      }
      const field = textField(e.target);
      burst.current = {
        chars: e.key, lastAt: now, field,
        before: field ? field.value : '',
        caret: field ? field.selectionStart : null,
      };
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Keep the "· 2 minutes" age current while a scan is shown.
  useEffect(() => {
    if (!last) return undefined;
    const id = window.setInterval(() => setTick((n) => n + 1), AGE_TICK_MS);
    return () => window.clearInterval(id);
  }, [last]);

  const age = last ? ageText(last.at) : '';
  return (
    <DeviceCard
      title="Barcode scanner"
      wide
      pill={last ? { label: 'Working', tone: 'green' } : { label: 'Scan to test', tone: 'slate' }}
      actions={(
        <button type="button" className="mini-btn" disabled={!last} onClick={() => setLast(null)}>
          Clear
        </button>
      )}
    >
      <div className="device-scan-area">
        <p>Scan any barcode now. It shows here and nowhere else.</p>
        {last && (
          <p className="device-scan-last mono" data-testid="scanner-last" title={fullDateTime(last.at)}>
            {`Last scan: ${last.value} · ${age === 'just now' ? age : `${age} ago`}`}
          </p>
        )}
      </div>
      <p className="page-hint">Scanners type like a keyboard, so the kiosk can&apos;t see one until it scans.</p>
    </DeviceCard>
  );
}
