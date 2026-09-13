/** Guardrail: the kiosk may import from @portal only stylesheets and
 *  React-free TypeScript. Importing a portal .tsx (or a .ts that imports
 *  react) would bundle a second React and break every hook. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const PORTAL = resolve(SRC, '../../portal/src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

it('every @portal import is a .css file or a React-free .ts file', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from\s+|import\s+)'@portal\/([^']+)'/g)) {
      const spec = m[1];
      if (spec.endsWith('.css')) continue;
      const target = resolve(PORTAL, spec.endsWith('.ts') ? spec : `${spec}.ts`);
      if (!existsSync(target)) {
        offenders.push(`${file}: @portal/${spec} is not a .css or .ts file`);
        continue;
      }
      if (/from\s+'react/.test(readFileSync(target, 'utf8'))) {
        offenders.push(`${file}: @portal/${spec} imports react`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
