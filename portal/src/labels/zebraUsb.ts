/**
 * Zebra-over-WebUSB transport — V2's PrintLabels.jsx connection, send and
 * `~HS` host-status polling, lifted into a pure module over a narrow
 * device interface so it runs against a fake in tests and against
 * `navigator.usb` in the browser (`lib/useZebraPrinter.ts`). No React.
 *
 * WebUSB needs Chromium on a secure context (https or localhost); callers
 * check `'usb' in navigator` before offering the connect button.
 */

import { dpiFromDotsPerMm } from './zebraCommands';

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

export interface ReadOptions { firstTimeoutMs?: number; drainTimeoutMs?: number; maxReads?: number }

/** Read whatever the printer sends back: one read with a longer timeout,
 *  then short drain reads until one times out or `maxReads` is reached.
 *  '' when there is no bulk IN endpoint or nothing arrives. */
export async function readText(
  device: UsbDeviceLike, { firstTimeoutMs = 2000, drainTimeoutMs = 250, maxReads = 8 }: ReadOptions = {},
  clock: Clock = realClock,
): Promise<string> {
  const { in: inEp } = findBulkEndpoints(device);
  if (!inEp) return '';
  const readWithTimeout = (ms: number) => Promise.race([
    device.transferIn(inEp.endpointNumber, 4096),
    clock.sleep(ms).then(() => { throw new Error('read timeout'); }),
  ]);
  const decoder = new TextDecoder();
  let text = '';
  for (let i = 0; i < maxReads; i++) {
    try {
      const r = await readWithTimeout(i === 0 ? firstTimeoutMs : drainTimeoutMs);
      text += decoder.decode(r.data);
    } catch {
      break;
    }
  }
  return text;
}

export async function query(
  device: UsbDeviceLike, command: string, opts: ReadOptions = {}, clock: Clock = realClock,
): Promise<string> {
  // Discard anything already pending (a straggler from a prior query) so it
  // can't get prepended to this query's response.
  await readText(device, { firstTimeoutMs: 40, drainTimeoutMs: 40, maxReads: 4 }, clock);
  await sendRaw(device, command);
  return readText(device, opts, clock);
}

/** Chunked bulk OUT for object downloads (`~DY` + TTF bytes). */
export async function sendBytes(
  device: UsbDeviceLike, bytes: Uint8Array,
  { chunkSize = 65536, onProgress }: { chunkSize?: number; onProgress?: (sent: number, total: number) => void } = {},
): Promise<void> {
  await ensureOpen(device);
  const { out } = findBulkEndpoints(device);
  if (!out) throw new Error('Could not find printer output endpoint');
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    await device.transferOut(out.endpointNumber, chunk);
    onProgress?.(Math.min(offset + chunkSize, bytes.length), bytes.length);
  }
}

const strip = (text: string) => text.replace(/[\x02\x03]/g, '');

export interface HostIdentification { model: string; firmware: string; dotsPerMm: number; memory: string; dpi: number }

/** `~HI` → `<STX>model,firmware,dotsPerMm,memory[,x]<ETX>`. A leftover frame
 *  from a prior query can precede the real response, so when the text
 *  contains STX, parse the LAST `<STX>…<ETX>` frame rather than the whole
 *  string; otherwise fall back to the whole stripped text. */
export function parseHostIdentification(text: string): HostIdentification | null {
  const stxFrames = text.split('\x02').slice(1);
  const body = stxFrames.length > 0
    ? stxFrames[stxFrames.length - 1].split('\x03')[0].trim()
    : strip(text).trim();
  const parts = body.split(',').map((p) => p.trim());
  if (parts.length < 4) return null;
  const dotsPerMm = parseInt(parts[2], 10);
  if (!parts[0] || Number.isNaN(dotsPerMm)) return null;
  return { model: parts[0], firmware: parts[1], dotsPerMm, memory: parts[3], dpi: dpiFromDotsPerMm(dotsPerMm) };
}

export interface HostStatus {
  paperOut: boolean; paused: boolean; labelLength: number; formatsQueued: number; bufferFull: boolean;
  partialFormat: boolean; corruptRam: boolean; underTemp: boolean; overTemp: boolean;
  headOpen: boolean; ribbonOut: boolean; thermalTransfer: boolean; printMode: string;
  labelWaiting: boolean; labelsRemaining: number;
}

/** `~HS` string 1 `aaa,b,c,dddd,eee,f,g,h,iii,j,k,l` and string 2
 *  `mmm,n,o,p,q,r,s,t,uuuuuuuu,v,www` (ZPL manual field order). */
export function parseHostStatus(text: string): HostStatus | null {
  const frames = text.split('\x02').slice(1).map((f) => f.split('\x03')[0].split(','));
  let i = -1;
  for (let k = frames.length - 1; k >= 0; k--) {
    if (frames[k].length >= 12 && (frames[k + 1]?.length ?? 0) >= 9) { i = k; break; }
  }
  if (i === -1) return null;
  const s1 = frames[i];
  const s2 = frames[i + 1];
  const flag = (v: string | undefined) => v?.trim() === '1';
  const int = (v: string | undefined) => { const n = parseInt(v ?? '', 10); return Number.isNaN(n) ? 0 : n; };
  return {
    paperOut: flag(s1[1]), paused: flag(s1[2]), labelLength: int(s1[3]), formatsQueued: int(s1[4]),
    bufferFull: flag(s1[5]), partialFormat: flag(s1[7]), corruptRam: flag(s1[9]),
    underTemp: flag(s1[10]), overTemp: flag(s1[11]),
    headOpen: flag(s2[2]), ribbonOut: flag(s2[3]), thermalTransfer: flag(s2[4]),
    printMode: (s2[5] ?? '').trim(), labelWaiting: flag(s2[7]), labelsRemaining: int(s2[8]),
  };
}

export interface DirectoryListing { objects: { name: string; bytes: number }[]; bytesFree: number | null }

/** `^HW` → `- DIR E:*.*` header, `* NAME.EXT <bytes>` rows, `-<n> bytes free` trailer. */
export function parseDirectory(text: string): DirectoryListing | null {
  const body = strip(text);
  if (!/DIR\s+\w:/i.test(body)) return null;
  const objects: { name: string; bytes: number }[] = [];
  let bytesFree: number | null = null;
  for (const line of body.split(/\r?\n/)) {
    const obj = line.match(/^\s*\*?\s*(?:[A-Z]:)?([A-Z0-9_]{1,8}\.[A-Z0-9]{1,3})\s+(\d+)\s*$/i);
    if (obj) { objects.push({ name: obj[1].toUpperCase(), bytes: parseInt(obj[2], 10) }); continue; }
    const free = line.match(/(\d+)\s+bytes free/i);
    if (free) bytesFree = parseInt(free[1], 10);
  }
  return { objects, bytesFree };
}

export interface PrinterConfiguration {
  darkness: number | null; printSpeed: number | null; tearOff: number | null; printMode: string | null;
  mediaType: string | null; printMethod: string | null; printWidth: number | null; labelLength: number | null;
  firmware: string | null; raw: Record<string, string>;
}

/** `^HH` → lines of `<value>   <LABEL>`; labels are upper-case words. */
export function parseConfiguration(text: string): PrinterConfiguration | null {
  const raw: Record<string, string> = {};
  for (const line of strip(text).split(/\r?\n/)) {
    const m = line.trim().match(/^(.*?)\s{2,}([A-Z][A-Z0-9 ./-]*[A-Z0-9])$/);
    if (m) raw[m[2]] = m[1].trim();
  }
  if (Object.keys(raw).length === 0) return null;
  const num = (label: string) => { const v = raw[label]; if (v === undefined) return null; const n = parseFloat(v); return Number.isNaN(n) ? null : n; };
  const str = (label: string) => raw[label] ?? null;
  return {
    darkness: num('DARKNESS'), printSpeed: num('PRINT SPEED'), tearOff: num('TEAR OFF'),
    printMode: str('PRINT MODE'), mediaType: str('MEDIA TYPE'), printMethod: str('PRINT METHOD'),
    printWidth: num('PRINT WIDTH'), labelLength: num('LABEL LENGTH'),
    firmware: raw.FIRMWARE ? raw.FIRMWARE.replace(/\s*<-\s*$/, '') : null, raw,
  };
}

/** Ask the printer how many formats are still queued; null when the status
 *  can't be read (closed device, no bulk IN, timeout, transfer error). */
export async function queryQueuedFormats(device: UsbDeviceLike, clock: Clock = realClock): Promise<number | null> {
  if (!device.opened) return null;
  const { in: inEp, out: outEp } = findBulkEndpoints(device);
  if (!inEp || !outEp) return null;
  try {
    const text = await query(device, '~HS', { firstTimeoutMs: 2000, drainTimeoutMs: 250, maxReads: 4 }, clock);
    return text ? parseHostStatusQueued(text) : null;
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
