/** The Zebra WebUSB transport against a fake device — V2's connect/send/
 *  ~HS-poll semantics (PrintLabels.jsx) without a printer. */
import { describe, expect, it, vi } from 'vitest';

import {
  ZEBRA_VENDOR_ID, closePrinter, ensureOpen, findBulkEndpoints, openPrinter, parseHostStatusQueued,
  queryQueuedFormats, requestZebraDevice, sendRaw, waitForPrinterIdle, type Clock, type UsbDeviceLike,
} from './zebraUsb';

class FakeDevice implements UsbDeviceLike {
  opened = false;
  productName = 'ZD421';
  configuration: UsbDeviceLike['configuration'] = null;
  log: string[] = [];
  sent: string[] = [];
  /** One entry per `~HS` query: the packets transferIn hands out for that
   *  query, in order. transferIn hangs once the current query's packets are
   *  exhausted (→ the transport's timeout path), so a later poll never sees
   *  an earlier poll's leftovers. */
  responses: string[][] = [];
  private pending: string[] = [];
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
    if (text === '~HS') this.pending = [...(this.responses.shift() ?? [])];
  }
  async transferIn(endpoint: number, _length: number) {
    this.log.push(`in:${endpoint}`);
    const next = this.pending.shift();
    if (next === undefined) return new Promise<{ data?: DataView }>(() => undefined); // hangs → timeout path
    const bytes = new TextEncoder().encode(next);
    return { data: new DataView(bytes.buffer) };
  }
}

const instantClock = (): Clock & { slept: number[] } => {
  let t = 0;
  const slept: number[] = [];
  return { slept, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } };
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
