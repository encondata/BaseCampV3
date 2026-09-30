/** Guardrail: the kiosk may import from @portal only
 *    - stylesheets,
 *    - React-free TypeScript (a .ts file that doesn't import react),
 *    - the allowlisted React modules the shared sign-in scene is built from.
 *
 *  The rule exists because portal files resolve their bare packages from
 *  portal/node_modules: without `resolve.dedupe` the kiosk would bundle a
 *  SECOND React and every hook would break. So an allowlisted React module
 *  is only safe while its whole transitive reach (following relative
 *  imports through portal/src) stays inside packages the kiosk dedupes —
 *  which this test also checks, rather than trusting the allowlist.
 *
 *  The wiki does the same thing on a larger scale (it imports the portal's
 *  whole Login page); this is the kiosk's smaller version of that rule.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const PORTAL = resolve(SRC, '../../portal/src');
const VITE_CONFIG = resolve(SRC, '../vite.config.ts');

/** Portal React modules the kiosk may import (paths under portal/src, no
 *  extension); a trailing `/*` allows every module in that folder. The
 *  sign-in scene is shared on purpose — the kiosk, portal and wiki show
 *  the same page. */
const REACT_ALLOWLIST = ['components/login/*'];

// static `import … from '…'`, `import '…'` and `export … from '…'`
const IMPORT_RE = /^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx?$/.test(name) && !name.startsWith('._') ? [p] : [];
  });
}

/** Runtime imports only — `import type` is erased and pulls in nothing. */
function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(IMPORT_RE)]
    .filter((m) => !m[1])
    .map((m) => m[2].split('?')[0]);
}

function resolveModule(base: string): string | null {
  if (/\.(css|tsx?)$/.test(base)) return existsSync(base) ? base : null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function allowed(spec: string): boolean {
  return REACT_ALLOWLIST.some((entry) => (
    entry.endsWith('/*') ? spec.startsWith(entry.slice(0, -1)) : entry === spec
  ));
}

/** Every @portal specifier imported anywhere in kiosk/src. */
function portalSpecs(): { file: string; spec: string }[] {
  return walk(SRC).flatMap((file) => importsOf(file)
    .filter((spec) => spec.startsWith('@portal/'))
    .map((spec) => ({ file, spec: spec.slice('@portal/'.length) })));
}

it('every @portal import is a stylesheet, a React-free .ts file, or allowlisted', () => {
  const offenders: string[] = [];
  for (const { file, spec } of portalSpecs()) {
    if (spec.endsWith('.css')) continue;
    if (allowed(spec)) {
      if (resolveModule(resolve(PORTAL, spec)) === null) {
        offenders.push(`${file}: @portal/${spec} is allowlisted but does not exist`);
      }
      continue;
    }
    const target = resolve(PORTAL, spec.endsWith('.ts') ? spec : `${spec}.ts`);
    if (!existsSync(target)) {
      offenders.push(`${file}: @portal/${spec} is not a .css or .ts file, and is not allowlisted`);
      continue;
    }
    if (/from\s+'react/.test(readFileSync(target, 'utf8'))) {
      offenders.push(`${file}: @portal/${spec} imports react`);
    }
  }
  expect(offenders).toEqual([]);
});

/** Walk an allowlisted module's relative imports through portal/src and
 *  collect the bare packages the whole reach depends on. */
function barePackagesUnder(entry: string): Set<string> {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (spec.startsWith('.')) {
        const next = resolveModule(resolve(dirname(file), spec));
        if (next && !/\.css$/.test(next)) queue.push(next);
        continue;
      }
      if (spec.startsWith('@portal/')) {
        const next = resolveModule(resolve(PORTAL, spec.slice('@portal/'.length)));
        if (next && !/\.css$/.test(next)) queue.push(next);
        continue;
      }
      // "@scope/name/deep" → "@scope/name"; "name/deep" → "name"
      const parts = spec.split('/');
      packages.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    }
  }
  return packages;
}

it('every package an allowlisted portal module reaches is deduped by the kiosk', () => {
  const config = readFileSync(VITE_CONFIG, 'utf8');
  const deduped = new Set(
    [...(/dedupe:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]),
  );

  const missing: string[] = [];
  for (const { spec } of portalSpecs()) {
    if (!allowed(spec)) continue;
    const entry = resolveModule(resolve(PORTAL, spec));
    if (!entry) continue;
    for (const pkg of barePackagesUnder(entry)) {
      if (!deduped.has(pkg)) missing.push(`@portal/${spec} reaches '${pkg}', which vite.config.ts does not dedupe`);
    }
  }
  expect([...new Set(missing)]).toEqual([]);
});
