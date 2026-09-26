/** Guardrail: the wiki may import from @portal only
 *    - stylesheets under styles/,
 *    - React-free TypeScript under lib/ (a .ts file that doesn't import react),
 *    - the allowlisted React modules the portal sign-in is built from.
 *  Everything the allowlisted React modules pull in (following their
 *  relative imports through portal/src) resolves its bare packages from
 *  portal/node_modules unless the wiki dedupes them — so every such package
 *  must be a wiki dependency AND in resolve.dedupe, or the wiki would bundle
 *  a second React/router and every hook would break. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { dedupe } from '../../dedupe';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const PORTAL = resolve(SRC, '../../../portal/src');
const PACKAGE_JSON = resolve(SRC, '../../package.json');

/** Portal React modules the wiki may import (paths under portal/src, no
 *  extension); a trailing `/*` allows every module in that folder. */
const REACT_ALLOWLIST = [
  'auth/AuthContext',
  'pages/Login',
  'components/totp/*',
  'components/SystemBanners',
  'components/ComboBox',
  'components/ToastHost',
  // the providers SystemBanners and ToastHost read from (without them the
  // banners never show and toasts are silently dropped)
  'lib/systemStatusContext',
  'lib/notificationsContext',
];

// static `import … from '…'`, `import '…'` and `export … from '…'`; the
// clause may span lines but never holds a quote or a semicolon
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
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(IMPORT_RE)].filter((m) => !m[1]).map((m) => m[2].split('?')[0]);
}

function resolveModule(base: string): string | null {
  if (/\.(css|tsx?)$/.test(base)) return existsSync(base) ? base : null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function portalModule(file: string): string {
  return relative(PORTAL, file).replace(/\.tsx?$/, '');
}

function isAllowlistedReact(mod: string): boolean {
  return REACT_ALLOWLIST.some((entry) => (entry.endsWith('/*')
    ? dirname(mod) === entry.slice(0, -2)
    : mod === entry));
}

function importsReact(file: string): boolean {
  return importsOf(file).some((spec) => spec === 'react' || spec.startsWith('react/')
    || spec === 'react-dom' || spec.startsWith('react-dom/'));
}

function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Every @portal import in wiki/web/src, resolved to a file under portal/src. */
function portalImports(): { from: string; spec: string; target: string | null }[] {
  return walk(SRC).flatMap((from) => importsOf(from)
    .filter((spec) => spec.startsWith('@portal/'))
    .map((spec) => ({
      from: relative(SRC, from),
      spec,
      target: resolveModule(resolve(PORTAL, spec.slice('@portal/'.length))),
    })));
}

it('every @portal import is a stylesheet, a React-free lib module or an allowlisted React module', () => {
  const found = portalImports();
  const offenders: string[] = [];
  for (const { from, spec, target } of found) {
    if (!target) {
      offenders.push(`${from}: ${spec} does not resolve under portal/src`);
      continue;
    }
    const mod = relative(PORTAL, target);
    if (mod.endsWith('.css')) {
      if (!mod.startsWith('styles/')) offenders.push(`${from}: ${spec} is a stylesheet outside styles/`);
      continue;
    }
    if (isAllowlistedReact(portalModule(target))) continue;
    if (!mod.startsWith('lib/') || !mod.endsWith('.ts')) {
      offenders.push(`${from}: ${spec} is not an allowlisted portal module`);
    } else if (importsReact(target)) {
      offenders.push(`${from}: ${spec} imports react (only allowlisted React modules may)`);
    }
  }
  expect(offenders).toEqual([]);
  // not vacuous: the sign-in really does come from the portal
  expect(found.map((f) => f.spec)).toContain('@portal/pages/Login');
});

it('every package the portal modules pull in is a wiki dependency and deduped', () => {
  const entries = [
    // the whole allowlist, so adopting another allowlisted module later
    // can't slip a new package past this check
    ...walk(PORTAL).filter((f) => !/\.test\.tsx?$/.test(f) && isAllowlistedReact(portalModule(f))),
    // plus every non-CSS portal module the wiki actually imports
    ...portalImports().map((i) => i.target).filter((t): t is string => !!t && !t.endsWith('.css')),
  ];

  const packages = new Map<string, Set<string>>();   // package → portal files importing it
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('.css')) continue;
    for (const spec of importsOf(file)) {
      if (spec.startsWith('.')) {
        const target = resolveModule(resolve(dirname(file), spec));
        if (target) queue.push(target);
        else unresolved.push(`${relative(PORTAL, file)}: ${spec}`);
      } else if (spec.startsWith('@portal/')) {
        unresolved.push(`${relative(PORTAL, file)}: ${spec} (portal code never uses @portal)`);
      } else if (!spec.startsWith('node:')) {
        const name = packageName(spec);
        if (!packages.has(name)) packages.set(name, new Set());
        packages.get(name)!.add(relative(PORTAL, file));
      }
    }
  }
  expect(unresolved).toEqual([]);
  expect(packages.has('react')).toBe(true);   // not vacuous

  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const offenders: string[] = [];
  for (const [name, importers] of packages) {
    const where = [...importers].sort().join(', ');
    if (!pkg.dependencies?.[name]) offenders.push(`${name} (${where}) is not in wiki/package.json dependencies`);
    if (!dedupe.includes(name)) offenders.push(`${name} (${where}) is not in wiki/dedupe.ts`);
  }
  expect(offenders).toEqual([]);
});
