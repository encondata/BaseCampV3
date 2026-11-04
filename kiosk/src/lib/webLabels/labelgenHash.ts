/**
 * Node only: never imported by the app. vite.config.ts calls this at build
 * time (and vitest, which reads the same config) to define
 * `__LABELGEN_HASH__`, which the web kiosk's label build keys its stored
 * labels on (`LABELGEN_HASH` in labelBuild.ts). `SOURCE_HASH` covers the
 * Python the reference labels were printed with; this covers the
 * TypeScript port itself, so a fix to the port alone still rebuilds every
 * stored label.
 *
 * sha256 over every `*.ts` directly in the labelgen directory, tests (and
 * macOS `._*` shadow files) left out, in name order, each as its name, a
 * NUL, its bytes and a NUL: deterministic for a given checkout.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The generator's source files in `dir`, in hash order. */
export function labelgenSources(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('._'))
    .sort();
}

/** The hex sha256 of the generator's sources in `dir`. */
export function labelgenSourcesHash(dir: string): string {
  const hash = createHash('sha256');
  for (const name of labelgenSources(dir)) {
    hash.update(name);
    hash.update('\0');
    hash.update(readFileSync(join(dir, name)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
