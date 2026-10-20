/**
 * A LAN Zebra shaped like the USB hook (`useZebraPrinter`), so the printer
 * tools written for USB — Full Printer Setup and Factory Reset — run
 * against a Label Station's network printer too. Every command goes
 * through the laptop edge (`/edge/printers/query|send`): queries must be
 * on the edge's exact allowlist, sends carry any ZPL.
 *
 * - `waitForIdle` polls `~HS` once a second until no formats are queued,
 *   for at most 60 seconds (then it just returns, as the USB one does).
 * - `ensureOpen` has no handle to open: it resolves once `~HI` answers, so
 *   Factory Reset's restart poll works unchanged. It never throws the USB
 *   hook's "Printer not connected" (that would end the poll for good).
 * - `log` records commands like the USB hook; `onChange` tells the page to
 *   re-render when it grows or is cleared.
 */

import { HOST_IDENTIFICATION, HOST_STATUS } from '@portal/labels/zebraCommands';
import { parseHostIdentification, parseHostStatus } from '@portal/labels/zebraUsb';

import { printerQuery, printerSend } from './api';
import type { PrinterLogEntry, ZebraPrinter } from './useZebraPrinter';

export type NetworkZebra = Pick<
  ZebraPrinter,
  'query' | 'send' | 'identify' | 'status' | 'log' | 'clearLog' | 'productName' | 'waitForIdle' | 'ensureOpen'
>;

export interface NetworkZebraOptions {
  /** Shown where the USB hook shows the USB product name. */
  productName?: string | null;
  onChange?: () => void;
  clock?: { now(): number; sleep(ms: number): Promise<void> };
}

const POLL_MS = 1000;
const IDLE_CAP_MS = 60000;

const realClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }),
};

export function networkZebraPrinter(ip: string, opts: NetworkZebraOptions = {}): NetworkZebra {
  const clock = opts.clock ?? realClock;
  let log: PrinterLogEntry[] = [];

  const record = (command: string, response: string) => {
    log = [...log, {
      at: new Date().toISOString(), command: command.slice(0, 200), response: response.slice(0, 2000),
    }].slice(-200);
    opts.onChange?.();
  };

  const query = async (command: string) => {
    const { response } = await printerQuery(ip, command);
    record(command, response);
    return response;
  };

  const queued = async (): Promise<number | null> => {
    try {
      return parseHostStatus(await query(HOST_STATUS))?.formatsQueued ?? null;
    } catch {
      return null;
    }
  };

  return {
    productName: opts.productName ?? null,
    get log() { return log; },
    clearLog: () => { log = []; opts.onChange?.(); },
    query,
    send: async (zpl) => {
      await printerSend(ip, zpl);
      record(zpl, '');
    },
    identify: async () => parseHostIdentification(await query(HOST_IDENTIFICATION)),
    status: async () => parseHostStatus(await query(HOST_STATUS)),
    waitForIdle: async (_labelsSent, onQueued) => {
      const deadline = clock.now() + IDLE_CAP_MS;
      for (;;) {
        const n = await queued();
        if (n !== null) {
          onQueued?.(n);
          if (n === 0) return;
        }
        await clock.sleep(POLL_MS);
        if (clock.now() >= deadline) return;
      }
    },
    ensureOpen: async () => {
      if (!parseHostIdentification(await query(HOST_IDENTIFICATION))) {
        throw new Error("The printer didn't answer.");
      }
    },
  };
}
