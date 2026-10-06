/**
 * importHandoff — carries one file from Bulk Actions › Convert Raw F-T to a
 * move's From-To import page across the in-app navigation. Memory only: a
 * reload loses it, like any file someone picked but hadn't imported yet.
 * Spec: docs/superpowers/specs/2026-10-06-raw-ft-import-handoff-design.md
 */
let pending: { initiativeId: string; file: File } | null = null;

export function handOffImportFile(initiativeId: string, file: File): void {
  pending = { initiativeId, file };
}

/** The file handed off for this initiative, without consuming it (safe in a
 *  lazy useState initializer, which StrictMode calls twice). */
export function peekHandedOffImportFile(initiativeId: string | undefined): File | null {
  return pending && initiativeId && pending.initiativeId === initiativeId ? pending.file : null;
}

export function clearHandedOffImportFile(initiativeId: string | undefined): void {
  if (pending && pending.initiativeId === initiativeId) pending = null;
}
