/** How the RFID reader's status reads on screen, shared by the RFID Reader
 *  Dashboard (/rfid_status) and Settings › Devices › RFID reader. */

import type { ReaderStatus } from './api';

export type ReaderState = 'loading' | 'reading' | 'stopped' | 'unreachable';

/** "Antennas 1 – 4" for a contiguous run, "Antennas 1, 3" otherwise. */
export function antennasLabel(antennas: string[]): string {
  if (antennas.length === 0) return 'No antennas connected';
  if (antennas.length === 1) return `Antenna ${antennas[0]}`;
  const nums = antennas.map(Number);
  const contiguous = nums.every((n, i) => Number.isInteger(n) && (i === 0 || n === nums[i - 1] + 1));
  return contiguous
    ? `Antennas ${antennas[0]} – ${antennas[antennas.length - 1]}`
    : `Antennas ${antennas.join(', ')}`;
}

export function readerState(status: ReaderStatus | null, failed: boolean): ReaderState {
  if (failed) return 'unreachable';
  if (!status) return 'loading';
  if (status.reachable === false) return 'unreachable';
  return status.reading ? 'reading' : 'stopped';
}
