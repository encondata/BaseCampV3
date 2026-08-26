/** Pure helpers for the process log viewer. */

import type { SystemLogEntry } from './api';

export function nextBackoff(prevMs: number): number {
  if (prevMs <= 0) return 1000;
  return Math.min(prevMs * 2, 30_000);
}

export function splitMessage(
  message: string,
): { head: string; rest: string | null } {
  const idx = message.indexOf('\n');
  if (idx === -1) return { head: message, rest: null };
  return { head: message.slice(0, idx), rest: message.slice(idx + 1) };
}

const KNOWN = new Set(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']);

export function levelClass(level: string): string {
  return `log-${KNOWN.has(level) ? level : 'INFO'}`;
}

export function mergeEntries(
  existing: SystemLogEntry[], incoming: SystemLogEntry[],
): SystemLogEntry[] {
  const seen = new Set(existing.map((e) => e.id));
  const merged = [...existing];
  for (const e of incoming) {
    if (!seen.has(e.id)) { merged.push(e); seen.add(e.id); }
  }
  return merged.sort((a, b) => a.id - b.id);
}
