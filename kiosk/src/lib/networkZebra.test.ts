/** The network Zebra adapter: the USB hook's calls, carried by the edge's
 *  `/edge/printers/query|send`. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ printerQuery: vi.fn(), printerSend: vi.fn() }));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()), ...api,
}));

const { networkZebraPrinter } = await import('./networkZebra');

const HI = '\x02ZD421-203dpi ZPL,V92.21.16Z,8,8192KB,X\x03';
const hs = (queued: number) =>
  `\x02030,0,0,1218,${String(queued).padStart(3, '0')},0,0,0,000,0,0,0\x03\r\n\x02000,0,0,0,0,2,4,0,00000000,1,000\x03`;

/** A clock that only moves when the adapter sleeps. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: vi.fn(async (ms: number) => { t += ms; }) };
}

beforeEach(() => {
  api.printerQuery.mockReset();
  api.printerSend.mockReset().mockResolvedValue(undefined);
});

describe('networkZebraPrinter', () => {
  it('maps query, send, identify and status onto the edge and logs each command', async () => {
    api.printerQuery.mockImplementation(async (_ip: string, command: string) => ({
      response: command === '~HI' ? HI : command === '~HS' ? hs(0) : 'reply', truncated: false,
    }));
    const onChange = vi.fn();
    const p = networkZebraPrinter('10.0.0.40', { productName: 'ZD421', onChange });
    expect(p.productName).toBe('ZD421');

    expect(await p.query('^XA^HH^XZ')).toBe('reply');
    expect(api.printerQuery).toHaveBeenLastCalledWith('10.0.0.40', '^XA^HH^XZ');
    await p.send('^XA^JUS^XZ');
    expect(api.printerSend).toHaveBeenCalledWith('10.0.0.40', '^XA^JUS^XZ');
    expect((await p.identify())?.dpi).toBe(203);
    expect((await p.status())?.formatsQueued).toBe(0);

    expect(p.log.map((e) => e.command)).toEqual(['^XA^HH^XZ', '^XA^JUS^XZ', '~HI', '~HS']);
    expect(p.log[0].response).toBe('reply');
    expect(onChange).toHaveBeenCalled();
    p.clearLog();
    expect(p.log).toEqual([]);
  });

  it('waitForIdle polls ~HS once a second until nothing is queued', async () => {
    const queued = [2, 1, 0];
    api.printerQuery.mockImplementation(async () => ({ response: hs(queued.shift() ?? 0), truncated: false }));
    const clock = fakeClock();
    const seen: number[] = [];
    await networkZebraPrinter('10.0.0.40', { clock }).waitForIdle(2, (n) => seen.push(n));
    expect(seen).toEqual([2, 1, 0]);
    expect(api.printerQuery).toHaveBeenCalledTimes(3);
    expect(api.printerQuery.mock.calls.every(([, c]) => c === '~HS')).toBe(true);
    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 1000]);
  });

  it('waitForIdle gives up after 60 seconds', async () => {
    api.printerQuery.mockRejectedValue(new Error('printer_unreachable'));
    const clock = fakeClock();
    await networkZebraPrinter('10.0.0.40', { clock }).waitForIdle(1);
    expect(clock.now()).toBe(60000);
    expect(api.printerQuery).toHaveBeenCalledTimes(60);
  });

  it('ensureOpen resolves once ~HI answers and throws while it does not', async () => {
    const p = networkZebraPrinter('10.0.0.40');
    api.printerQuery.mockRejectedValueOnce(new Error('printer_unreachable'));
    await expect(p.ensureOpen()).rejects.toThrow();
    api.printerQuery.mockResolvedValueOnce({ response: '', truncated: false });
    await expect(p.ensureOpen()).rejects.toThrow();
    api.printerQuery.mockResolvedValueOnce({ response: HI, truncated: false });
    await expect(p.ensureOpen()).resolves.toBeUndefined();
    expect(api.printerQuery).toHaveBeenLastCalledWith('10.0.0.40', '~HI');
  });
});
