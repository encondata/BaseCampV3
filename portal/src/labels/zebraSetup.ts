/** Pure logic for the Full printer setup wizard: choices derived from a
 *  `^HH` configuration, the commands to apply a change (only what
 *  changed), and confirm-by-re-read checks. */
import {
  setDarkness, setLabelSize, setMediaTracking, setPrintMethod, setPrintMode, setPrintSpeed,
  type MediaTracking, type PrintMethod, type PrintMode,
} from './zebraCommands';
import type { PrinterConfiguration } from './zebraUsb';

export interface MediaChoices {
  tracking: MediaTracking | null; method: PrintMethod | null; mode: PrintMode | null;
  widthDots: number | null; lengthDots: number | null;
}

const has = (v: string | null | undefined, needle: string) => (v ?? '').toUpperCase().includes(needle);

export function trackingFromMediaType(v: string | null): MediaTracking | null {
  if (has(v, 'GAP') || has(v, 'NOTCH') || has(v, 'WEB')) return 'W';
  if (has(v, 'MARK')) return 'M';
  if (has(v, 'CONTIN')) return 'N';
  return null;
}
export function methodFromPrintMethod(v: string | null): PrintMethod | null {
  if (has(v, 'DIRECT')) return 'D';
  if (has(v, 'THERMAL-TRANS') || has(v, 'TRANSFER')) return 'T';
  return null;
}
export function modeFromPrintMode(v: string | null): PrintMode | null {
  if (has(v, 'TEAR')) return 'T';
  if (has(v, 'PEEL')) return 'P';
  if (has(v, 'CUT')) return 'C';
  if (has(v, 'REWIND')) return 'R';
  return null;
}

export function mediaChoicesFromConfig(c: PrinterConfiguration | null): MediaChoices {
  if (!c) return { tracking: null, method: null, mode: null, widthDots: null, lengthDots: null };
  return {
    tracking: trackingFromMediaType(c.mediaType), method: methodFromPrintMethod(c.printMethod),
    mode: modeFromPrintMode(c.printMode), widthDots: c.printWidth, lengthDots: c.labelLength,
  };
}

export function commandsForMedia(current: MediaChoices, next: MediaChoices): string[] {
  const out: string[] = [];
  if (next.tracking && next.tracking !== current.tracking) out.push(setMediaTracking(next.tracking));
  if (next.method && next.method !== current.method) out.push(setPrintMethod(next.method));
  if (next.mode && next.mode !== current.mode) out.push(setPrintMode(next.mode));
  if (next.widthDots !== null && next.lengthDots !== null
      && (next.widthDots !== current.widthDots || next.lengthDots !== current.lengthDots)) {
    out.push(setLabelSize(next.widthDots, next.lengthDots));
  }
  return out;
}

export function confirmMedia(c: PrinterConfiguration | null, next: MediaChoices) {
  if (!c) return { tracking: null, method: null, mode: null, size: null } as Record<'tracking' | 'method' | 'mode' | 'size', boolean | null>;
  return {
    tracking: next.tracking === null ? null : trackingFromMediaType(c.mediaType) === next.tracking,
    method: next.method === null ? null : methodFromPrintMethod(c.printMethod) === next.method,
    mode: next.mode === null ? null : modeFromPrintMode(c.printMode) === next.mode,
    size: next.widthDots === null || next.lengthDots === null ? null : c.printWidth === next.widthDots && c.labelLength === next.lengthDots,
  };
}

export interface QualityChoices { darkness: number | null; speed: number | null }

export function qualityFromConfig(c: PrinterConfiguration | null): QualityChoices {
  return { darkness: c?.darkness ?? null, speed: c?.printSpeed ?? null };
}

export function commandsForQuality(current: QualityChoices, next: QualityChoices): string[] {
  const out: string[] = [];
  if (next.darkness !== null && next.darkness !== current.darkness) out.push(setDarkness(next.darkness));
  if (next.speed !== null && next.speed !== current.speed) out.push(setPrintSpeed(next.speed));
  return out;
}

export function confirmQuality(c: PrinterConfiguration | null, next: QualityChoices) {
  return {
    darkness: next.darkness === null || c?.darkness == null ? null : Math.abs(c.darkness - next.darkness) < 0.5,
    speed: next.speed === null || c?.printSpeed == null ? null : c.printSpeed === next.speed,
  } as Record<'darkness' | 'speed', boolean | null>;
}
