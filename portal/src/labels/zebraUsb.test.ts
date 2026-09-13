/** The Zebra WebUSB transport against a fake device — V2's connect/send/
 *  ~HS-poll semantics (PrintLabels.jsx) without a printer. */
import { describe, expect, it, vi } from 'vitest';

import { dpiFromDotsPerMm } from './zebraCommands';
import {
  ZEBRA_VENDOR_ID, closePrinter, ensureOpen, findBulkEndpoints, openPrinter, parseConfiguration, parseDirectory,
  parseHostIdentification, parseHostStatus, parseHostStatusQueued, query, queryQueuedFormats, readText,
  requestZebraDevice, sendBytes, sendRaw, waitForPrinterIdle, type Clock, type UsbDeviceLike,
} from './zebraUsb';

class FakeDevice implements UsbDeviceLike {
  opened = false;
  productName = 'ZD421';
  configuration: UsbDeviceLike['configuration'] = null;
  log: string[] = [];
  sent: string[] = [];
  sentBytes: Uint8Array[] = [];
  /** One entry per `~HS` query: the packets transferIn hands out for that
   *  query, in order. transferIn hangs once the current query's packets are
   *  exhausted (→ the transport's timeout path), so a later poll never sees
   *  an earlier poll's leftovers. */
  responses: string[][] = [];
  private pending: string[] = [];
  /** A read that found no packet waits here; the next loaded packet
   *  resolves it (real WebUSB delivers to the oldest outstanding read). */
  private waiting: ((r: { data?: DataView }) => void) | null = null;
  failOpen = false;
  constructor(endpoints: Array<{ direction: 'in' | 'out'; type: 'bulk' | 'interrupt' }> = [
    { direction: 'out', type: 'bulk' }, { direction: 'in', type: 'bulk' },
  ], configured = true) {
    if (configured) {
      this.configuration = { interfaces: [{ alternate: { endpoints: endpoints.map((e, i) => ({ ...e, endpointNumber: i + 1 })) } }] };
    }
  }
  async open() { if (this.failOpen) throw new Error('nope'); this.opened = true; this.log.push('open'); }
  async close() { this.opened = false; this.log.push('close'); }
  async selectConfiguration(n: number) { this.log.push(`selectConfiguration:${n}`); }
  async claimInterface(n: number) { this.log.push(`claim:${n}`); }
  async releaseInterface(n: number) { this.log.push(`release:${n}`); }
  async transferOut(endpoint: number, data: BufferSource) {
    this.log.push(`out:${endpoint}`);
    const text = new TextDecoder().decode(data as ArrayBuffer | ArrayBufferView);
    this.sent.push(text);
    this.sentBytes.push(new Uint8Array(data as Uint8Array));
    if (/^(~H|\^XA\^H)/.test(text)) {
      this.pending = [...(this.responses.shift() ?? [])];
      const next = this.pending.shift();
      if (this.waiting && next !== undefined) {
        const resolve = this.waiting; this.waiting = null;
        resolve({ data: new DataView(new TextEncoder().encode(next).buffer) });
      } else if (next !== undefined) {
        this.pending.unshift(next);
      }
    }
  }
  async transferIn(endpoint: number, _length: number) {
    this.log.push(`in:${endpoint}`);
    const next = this.pending.shift();
    if (next === undefined) return new Promise<{ data?: DataView }>((resolve) => { this.waiting = resolve; }); // waits for the next packet
    const bytes = new TextEncoder().encode(next);
    return { data: new DataView(bytes.buffer) };
  }
}

/** Virtual time: every sleep advances `t` by its argument and yields a few
 *  microtasks first, so an already-settled read always wins a race against a
 *  timeout — as it would against a real timer. */
const instantClock = (): Clock & { slept: number[] } => {
  let t = 0;
  const slept: number[] = [];
  return {
    slept, now: () => t,
    sleep: async (ms) => { slept.push(ms); t += ms; for (let i = 0; i < 4; i++) await Promise.resolve(); },
  };
};

describe('connect / disconnect', () => {
  it('requests with the Zebra vendor filter', async () => {
    const dev = new FakeDevice();
    const usb = { requestDevice: vi.fn(async () => dev) };
    expect(await requestZebraDevice(usb)).toBe(dev);
    expect(usb.requestDevice).toHaveBeenCalledWith({ filters: [{ vendorId: ZEBRA_VENDOR_ID }] });
  });
  it('opens: close-if-open, open, select config 1 when none, claim interface 0', async () => {
    const dev = new FakeDevice([], false);
    dev.opened = true;
    await openPrinter(dev);
    expect(dev.log).toEqual(['close', 'open', 'selectConfiguration:1', 'claim:0']);
  });
  it('skips selectConfiguration when one is already active', async () => {
    const dev = new FakeDevice();
    await openPrinter(dev);
    expect(dev.log).toEqual(['open', 'claim:0']);
  });
  it('closePrinter releases then closes and tolerates failures', async () => {
    const dev = new FakeDevice();
    dev.releaseInterface = async () => { throw new Error('already released'); };
    await expect(closePrinter(dev)).resolves.toBeUndefined();
    expect(dev.log).toEqual(['close']);
  });
  it('ensureOpen reopens a device that went stale, or throws the V2 message', async () => {
    const dev = new FakeDevice();
    await ensureOpen(dev);
    expect(dev.log).toEqual(['open', 'claim:0']);
    const dead = new FakeDevice();
    dead.failOpen = true;
    await expect(ensureOpen(dead)).rejects.toThrow('Printer connection lost. Please reconnect.');
  });
});

describe('sending', () => {
  it('finds the bulk endpoints and writes UTF-8 bytes to the OUT one', async () => {
    const dev = new FakeDevice([{ direction: 'in', type: 'interrupt' }, { direction: 'out', type: 'bulk' }, { direction: 'in', type: 'bulk' }]);
    dev.opened = true;
    const eps = findBulkEndpoints(dev);
    expect(eps.out?.endpointNumber).toBe(2);
    expect(eps.in?.endpointNumber).toBe(3);
    await sendRaw(dev, '^XA^FDhé^FS^XZ');
    expect(dev.log).toContain('out:2');
    expect(dev.sent).toEqual(['^XA^FDhé^FS^XZ']);
  });
  it('throws when there is no bulk OUT endpoint', async () => {
    const dev = new FakeDevice([{ direction: 'in', type: 'bulk' }]);
    dev.opened = true;
    await expect(sendRaw(dev, '^XA^XZ')).rejects.toThrow('Could not find printer output endpoint');
  });
});

describe('~HS host status', () => {
  it('parses the queued-format count from field 5 of string 1', () => {
    expect(parseHostStatusQueued('\x02030,0,0,1245,000,0,0,0,000,0,0,0\x03\r\n\x02000,0,0,0,0,2,4,0,00000000,1,000\x03')).toBe(0);
    expect(parseHostStatusQueued('\x02030,0,0,1245,007,0,0,0,000,0,0,0\x03')).toBe(7);
    expect(parseHostStatusQueued('garbage')).toBeNull();
    expect(parseHostStatusQueued('\x02abc')).toBeNull();
  });
  it('sends ~HS, reads the first packet, drains extra packets, and returns the count', async () => {
    const dev = new FakeDevice();
    dev.opened = true;
    dev.responses = [['\x02030,0,0,1245,003,0,0,0,000,0,0,0\x03', '\x02more\x03']];
    const clock = instantClock();
    expect(await queryQueuedFormats(dev, clock)).toBe(3);
    expect(dev.sent).toEqual(['~HS']);
    expect(dev.log.filter((l) => l.startsWith('in:')).length).toBeGreaterThanOrEqual(2);
  });
  it('returns null when the device is closed, lacks endpoints, or the read times out', async () => {
    const closed = new FakeDevice();
    expect(await queryQueuedFormats(closed, instantClock())).toBeNull();
    const noIn = new FakeDevice([{ direction: 'out', type: 'bulk' }]);
    noIn.opened = true;
    expect(await queryQueuedFormats(noIn, instantClock())).toBeNull();
    const silent = new FakeDevice();
    silent.opened = true;               // no responses → transferIn hangs
    expect(await queryQueuedFormats(silent, instantClock())).toBeNull();
  });
});

describe('waitForPrinterIdle', () => {
  it('polls once a second until the queue is empty, reporting each count', async () => {
    const dev = new FakeDevice();
    dev.opened = true;
    dev.responses = [
      ['\x02030,0,0,1245,002,0,0,0,000,0,0,0\x03'],
      ['\x02030,0,0,1245,001,0,0,0,000,0,0,0\x03'],
      ['\x02030,0,0,1245,000,0,0,0,000,0,0,0\x03'],
    ];
    const clock = instantClock();
    const onQueued = vi.fn();
    await waitForPrinterIdle(dev, 3, { onQueued, clock });
    expect(onQueued.mock.calls.map((c) => c[0])).toEqual([2, 1, 0]);
    expect(clock.slept.filter((ms) => ms === 1000).length).toBe(2);
  });
  it('falls back to ~0.5 s per label (capped at 30 s) when status is unreadable from the start', async () => {
    const dev = new FakeDevice([{ direction: 'out', type: 'bulk' }]);
    dev.opened = true;
    const clock = instantClock();
    await waitForPrinterIdle(dev, 10, { clock });
    expect(clock.slept).toEqual([5000]);
    const big = instantClock();
    await waitForPrinterIdle(dev, 1000, { clock: big });
    expect(big.slept).toEqual([30000]);
  });
  it('gives up at the deadline (max 30 s, 3 s per label) when the queue never drains', async () => {
    const dev = new FakeDevice();
    dev.opened = true;
    dev.responses = Array.from({ length: 50 }, () => ['\x02030,0,0,1245,001,0,0,0,000,0,0,0\x03']);
    const clock = instantClock();
    await waitForPrinterIdle(dev, 2, { clock });
    // the instant clock advances on every sleep call, including the losing
    // side of the read-timeout race (2000 + 250 per poll) plus the 1 s loop
    // sleep, so ~10 polls reach the 30 s deadline
    expect(clock.now()).toBeGreaterThanOrEqual(30000);
    expect(clock.now()).toBeLessThan(40000);
  });
});

const HI = '\x02ZD421-203dpi ZPL,V92.21.16Z,8,8192KB,X\x03';
const HS = '\x02030,1,0,1245,003,0,0,0,000,0,0,1\x03\r\n\x02000,0,1,0,0,2,4,0,00000012,1,000\x03\r\n\x021234,0\x03';
const HW = '\x02- DIR E:*.*\r\n* 85620388.TTF       124336\r\n* TT0003M_.TTF      169188\r\n-1928576 bytes free E: ONBOARD FLASH\r\n\x03';
// Real `^HW` listings print a drive prefix on each row (`*E:NAME.EXT bytes`);
// the ZPL manual's own example (`*R:ARIALN1.FNT 49140`) carries one too.
const HW_DRIVE_PREFIXED = '\x02- DIR E:*.*\r\n*E:85620388.TTF  124336\r\n*E:TT0003M_.TTF 169188\r\n-1928576 bytes free E: ONBOARD FLASH\r\n\x03';
const HH = [
  '\x02', '+10.0               DARKNESS', '6.0 IPS             PRINT SPEED', '+000                TEAR OFF',
  'TEAR OFF            PRINT MODE', 'GAP/NOTCH           MEDIA TYPE', 'DIRECT-THERMAL      PRINT METHOD',
  '812                 PRINT WIDTH', '1218                LABEL LENGTH', 'V72.19.15Z <-       FIRMWARE',
  'NORMAL MODE         PRINT MODE FLAG', '\x03',
].join('\r\n');

describe('readText / query / sendBytes', () => {
  it('reads the first packet and drains the rest, returning everything', async () => {
    const dev = new FakeDevice(); dev.opened = true;
    dev.responses = [['\x02abc', 'def\x03']];
    expect(await query(dev, '~HI', {}, instantClock())).toBe('\x02abcdef\x03');
    expect(dev.sent).toEqual(['~HI']);
  });
  it('returns an empty string when nothing arrives or there is no bulk IN', async () => {
    const silent = new FakeDevice(); silent.opened = true;
    expect(await readText(silent, {}, instantClock())).toBe('');
    const noIn = new FakeDevice([{ direction: 'out', type: 'bulk' }]); noIn.opened = true;
    expect(await readText(noIn, {}, instantClock())).toBe('');
  });
  it('sends bytes in chunks and reports progress', async () => {
    const dev = new FakeDevice(); dev.opened = true;
    const bytes = new Uint8Array(150_000).map((_, i) => i % 251);
    const progress: [number, number][] = [];
    await sendBytes(dev, bytes, { chunkSize: 65536, onProgress: (s, t) => progress.push([s, t]) });
    expect(dev.sentBytes.map((b) => b.length)).toEqual([65536, 65536, 18928]);
    expect(progress).toEqual([[65536, 150000], [131072, 150000], [150000, 150000]]);
    expect(Buffer.concat(dev.sentBytes.map((b) => Buffer.from(b)))).toEqual(Buffer.from(bytes));
  });
});

describe('parsers', () => {
  it('parses ~HI', () => {
    expect(parseHostIdentification(HI)).toEqual({ model: 'ZD421-203dpi ZPL', firmware: 'V92.21.16Z', dotsPerMm: 8, memory: '8192KB', dpi: dpiFromDotsPerMm(8) });
    expect(parseHostIdentification('garbage')).toBeNull();
    expect(parseHostIdentification('')).toBeNull();
  });
  it('parses the LAST <STX>…<ETX> frame when a leftover frame precedes the real response', () => {
    expect(parseHostIdentification('\x02junk,1\x03\x02ZD421-203dpi ZPL,V92.21.16Z,8,8192KB,X\x03'))
      .toEqual({ model: 'ZD421-203dpi ZPL', firmware: 'V92.21.16Z', dotsPerMm: 8, memory: '8192KB', dpi: dpiFromDotsPerMm(8) });
  });
  it('parses the three ~HS strings', () => {
    const s = parseHostStatus(HS)!;
    expect(s.paperOut).toBe(true); expect(s.paused).toBe(false); expect(s.labelLength).toBe(1245);
    expect(s.formatsQueued).toBe(3); expect(s.bufferFull).toBe(false); expect(s.overTemp).toBe(true);
    expect(s.underTemp).toBe(false); expect(s.headOpen).toBe(true); expect(s.ribbonOut).toBe(false);
    expect(s.thermalTransfer).toBe(false); expect(s.printMode).toBe('2'); expect(s.labelsRemaining).toBe(12);
    expect(parseHostStatus('\x02030,0\x03')).toBeNull();
    expect(parseHostStatus('')).toBeNull();
  });
  it('requires string 2 (a partial read is not a confident Ready), and skips leftover junk frames', () => {
    // String 1 alone, however well-formed, must not report a confident status.
    expect(parseHostStatus('\x02030,1,0,1245,003,0,0,0,000,0,0,1\x03')).toBeNull();
    // Leftover frames from an earlier, unrelated read precede the real
    // response; the last full string1+string2 pair still parses.
    const withLeftover = '\x02garbage\x03\x02x,y\x03' + HS;
    expect(parseHostStatus(withLeftover)).toEqual(parseHostStatus(HS));
  });
  it('parses an E: directory listing', () => {
    expect(parseDirectory(HW)).toEqual({ objects: [{ name: '85620388.TTF', bytes: 124336 }, { name: 'TT0003M_.TTF', bytes: 169188 }], bytesFree: 1928576 });
    expect(parseDirectory('\x02- DIR E:*.*\r\n-2000000 bytes free E:\x03')).toEqual({ objects: [], bytesFree: 2000000 });
    expect(parseDirectory('')).toBeNull();
  });
  it('keeps only the last DIR block and collapses repeated names (a straggling earlier listing)', () => {
    const twice = '\x02- DIR E:*.*\r\n*E:85620388.TTF  1035\r\n*E:IN001.DMP  900\r\n-2000 bytes free E:\x03'
      + '\x02- DIR E:*.*\r\n*E:85620388.TTF  1036\r\n*E:IN001.DMP  901\r\n-1999 bytes free E:\x03';
    expect(parseDirectory(twice)).toEqual({ objects: [{ name: '85620388.TTF', bytes: 1036 }, { name: 'IN001.DMP', bytes: 901 }], bytesFree: 1999 });
    const dup = '\x02- DIR E:*.*\r\n*E:A.TTF  1\r\n*E:A.TTF  2\r\n-5 bytes free E:\x03';
    expect(parseDirectory(dup)).toEqual({ objects: [{ name: 'A.TTF', bytes: 2 }], bytesFree: 5 });
  });
  it('parses rows that carry the drive prefix real ^HW listings print (e.g. `*E:NAME.EXT bytes`)', () => {
    expect(parseDirectory(HW_DRIVE_PREFIXED)).toEqual(parseDirectory(HW));
  });
  it('parses ^HH configuration', () => {
    const c = parseConfiguration(HH)!;
    expect(c.darkness).toBe(10); expect(c.printSpeed).toBe(6); expect(c.tearOff).toBe(0);
    expect(c.printMode).toBe('TEAR OFF'); expect(c.mediaType).toBe('GAP/NOTCH'); expect(c.printMethod).toBe('DIRECT-THERMAL');
    expect(c.printWidth).toBe(812); expect(c.labelLength).toBe(1218); expect(c.firmware).toBe('V72.19.15Z');
    expect(c.raw['PRINT MODE FLAG']).toBe('NORMAL MODE');
    expect(parseConfiguration('')).toBeNull();
    expect(parseConfiguration('no labels here')).toBeNull();
  });
});

/** A device with real WebUSB delivery semantics: every `transferIn` is a
 *  queued read, and an incoming packet is handed to the OLDEST outstanding
 *  read — including one the transport gave up waiting on. The other fake
 *  above hangs forever, which hides exactly that behavior. */
class FifoDevice extends FakeDevice {
  private readers: Array<(r: { data?: DataView }) => void> = [];
  transferInCalls = 0;
  get pendingReads() { return this.readers.length; }
  async transferOut(endpoint: number, data: BufferSource) {
    this.log.push(`out:${endpoint}`);
    this.sent.push(new TextDecoder().decode(data as ArrayBuffer | ArrayBufferView));
  }
  async transferIn(endpoint: number, _length: number) {
    this.log.push(`in:${endpoint}`);
    this.transferInCalls += 1;
    return new Promise<{ data?: DataView }>((resolve) => { this.readers.push(resolve); });
  }
  /** The printer sends a packet: the oldest outstanding read receives it. */
  deliver(text: string) {
    const bytes = new TextEncoder().encode(text);
    this.readers.shift()?.({ data: new DataView(bytes.buffer) });
  }
}

describe('WebUSB read queue (a timed-out transferIn still receives the next packet)', () => {
  it('reuses the outstanding read instead of issuing another, so the next reply is not swallowed', async () => {
    const dev = new FifoDevice(); dev.opened = true;
    const clock = instantClock();
    expect(await readText(dev, { firstTimeoutMs: 40, maxReads: 1 }, clock)).toBe('');
    expect(dev.pendingReads).toBe(1);
    await sendRaw(dev, '~HI');
    dev.deliver('\x02ZD421-203dpi ZPL,V92.21.16Z,8,8192KB,X\x03');   // lands in the timed-out read
    expect(await readText(dev, { firstTimeoutMs: 2000, drainTimeoutMs: 40, maxReads: 4 }, clock))
      .toBe('\x02ZD421-203dpi ZPL,V92.21.16Z,8,8192KB,X\x03');
    expect(dev.transferInCalls).toBe(2);   // the first read was reused; one more for the drain
  });
  it('query() after a straggler returns only the fresh reply', async () => {
    const dev = new FifoDevice(); dev.opened = true;
    const clock = instantClock();
    const q = query(dev, '^XA^HH^XZ', { firstTimeoutMs: 2000, drainTimeoutMs: 40, maxReads: 4 }, clock);
    // the pre-drain's read times out and stays outstanding; once the command
    // has gone out, the printer's reply lands in that same read
    while (!dev.sent.includes('^XA^HH^XZ')) await Promise.resolve();
    expect(dev.pendingReads).toBe(1);
    dev.deliver('\x02+10.0               DARKNESS\r\n\x03');
    expect(await q).toContain('DARKNESS');
  });
  it('closePrinter forgets the outstanding read so a reopened device starts clean', async () => {
    const dev = new FifoDevice(); dev.opened = true;
    const clock = instantClock();
    expect(await readText(dev, { firstTimeoutMs: 40, maxReads: 1 }, clock)).toBe('');
    await closePrinter(dev);
    dev.opened = true;
    void readText(dev, { firstTimeoutMs: 40, maxReads: 1 }, clock);
    await Promise.resolve();
    expect(dev.transferInCalls).toBe(2);   // a fresh read was issued after close
  });
});
