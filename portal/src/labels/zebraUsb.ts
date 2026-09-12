/**
 * Zebra-over-WebUSB transport — V2's PrintLabels.jsx connection, send and
 * `~HS` host-status polling, lifted into a pure module over a narrow
 * device interface so it runs against a fake in tests and against
 * `navigator.usb` in the browser (`lib/useZebraPrinter.ts`). No React.
 *
 * WebUSB needs Chromium on a secure context (https or localhost); callers
 * check `'usb' in navigator` before offering the connect button.
 */

export const ZEBRA_VENDOR_ID = 0x0a5f; // Zebra Technologies

export interface UsbEndpointLike {
  direction: 'in' | 'out';
  type: 'bulk' | 'interrupt' | 'isochronous';
  endpointNumber: number;
}

export interface UsbDeviceLike {
  readonly opened: boolean;
  readonly productName?: string;
  readonly configuration: { interfaces: { alternate: { endpoints: UsbEndpointLike[] } }[] } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  transferOut(endpoint: number, data: BufferSource): Promise<unknown>;
  transferIn(endpoint: number, length: number): Promise<{ data?: DataView }>;
}

export interface UsbLike {
  requestDevice(opts: { filters: { vendorId: number }[] }): Promise<UsbDeviceLike>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function requestZebraDevice(usb: UsbLike): Promise<UsbDeviceLike> {
  return usb.requestDevice({ filters: [{ vendorId: ZEBRA_VENDOR_ID }] });
}

/** V2's handleConnectPrinter sequence after requestDevice. */
export async function openPrinter(device: UsbDeviceLike): Promise<void> {
  if (device.opened) {
    try { await device.close(); } catch { /* was open; ignore */ }
  }
  await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  await device.claimInterface(0);
}

/** Release interface 0 then close, each tolerant — V2 deliberately never
 *  calls forget(), which would make the device object stale. */
export async function closePrinter(device: UsbDeviceLike): Promise<void> {
  try { await device.releaseInterface(0); } catch { /* ignore */ }
  try { await device.close(); } catch { /* ignore */ }
}

/** V2's reopen-on-stale path at the top of sendZplToPrinter. */
export async function ensureOpen(device: UsbDeviceLike): Promise<void> {
  if (device.opened) return;
  try {
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    await device.claimInterface(0);
  } catch {
    throw new Error('Printer connection lost. Please reconnect.');
  }
}

export function findBulkEndpoints(device: UsbDeviceLike): { out: UsbEndpointLike | null; in: UsbEndpointLike | null } {
  const endpoints = device.configuration?.interfaces?.[0]?.alternate?.endpoints ?? [];
  return {
    out: endpoints.find((e) => e.direction === 'out' && e.type === 'bulk') ?? null,
    in: endpoints.find((e) => e.direction === 'in' && e.type === 'bulk') ?? null,
  };
}

/** Raw bytes to the printer's bulk OUT endpoint. Callers apply the print
 *  settings transform first (`lib/printLabels.ts` applyPrintSettings). */
export async function sendRaw(device: UsbDeviceLike, text: string): Promise<void> {
  await ensureOpen(device);
  const { out } = findBulkEndpoints(device);
  if (!out) throw new Error('Could not find printer output endpoint');
  await device.transferOut(out.endpointNumber, new TextEncoder().encode(text));
}

/** `~HS` string 1 is `<STX>aaa,b,c,dddd,eee,…<ETX>`; field 5 (eee) is the
 *  number of formats in the receive buffer. */
export function parseHostStatusQueued(text: string): number | null {
  const string1 = text.split('\x02')[1];
  if (!string1) return null;
  const queued = parseInt(string1.split(',')[4], 10);
  return Number.isNaN(queued) ? null : queued;
}

const STATUS_FIRST_READ_MS = 2000;
const STATUS_DRAIN_READ_MS = 250;
const STATUS_DRAIN_READS = 3;

/** Ask the printer how many formats are still queued; null when the status
 *  can't be read (closed device, no bulk IN, timeout, transfer error). */
export async function queryQueuedFormats(device: UsbDeviceLike, clock: Clock = realClock): Promise<number | null> {
  if (!device.opened) return null;
  const { in: inEp, out: outEp } = findBulkEndpoints(device);
  if (!inEp || !outEp) return null;
  const readWithTimeout = (ms: number) => Promise.race([
    device.transferIn(inEp.endpointNumber, 256),
    clock.sleep(ms).then(() => { throw new Error('status timeout'); }),
  ]);
  try {
    await device.transferOut(outEp.endpointNumber, new TextEncoder().encode('~HS'));
    const decoder = new TextDecoder();
    let text = decoder.decode((await readWithTimeout(STATUS_FIRST_READ_MS)).data);
    // The 3 STX-framed strings can arrive as separate packets — drain them
    // so stale data doesn't confuse the next poll.
    for (let i = 0; i < STATUS_DRAIN_READS; i++) {
      try {
        text += decoder.decode((await readWithTimeout(STATUS_DRAIN_READ_MS)).data);
      } catch {
        break; // drained
      }
    }
    return parseHostStatusQueued(text);
  } catch {
    return null;
  }
}

/** Wait until the printer has physically printed everything sent: poll
 *  `~HS` once a second until the receive buffer is empty, reporting each
 *  queued count via `onQueued`. Deadline max(30 s, 3 s × labels). If status
 *  is unreadable from the first poll, sleep ~0.5 s per label (max 30 s)
 *  instead; a transient failure after a successful read keeps polling. */
export async function waitForPrinterIdle(
  device: UsbDeviceLike, labelsSent: number,
  { onQueued, clock = realClock }: { onQueued?: (queued: number) => void; clock?: Clock } = {},
): Promise<void> {
  const deadline = clock.now() + Math.max(30000, labelsSent * 3000);
  let statusAvailable = false;
  while (clock.now() < deadline) {
    const queued = await queryQueuedFormats(device, clock);
    if (queued === null) {
      if (!statusAvailable) {
        await clock.sleep(Math.min(labelsSent * 500, 30000));
        return;
      }
    } else {
      statusAvailable = true;
      onQueued?.(queued);
      if (queued === 0) return;
    }
    await clock.sleep(1000);
  }
}
