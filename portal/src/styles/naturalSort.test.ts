/**
 * Guardrail: text ordering goes through lib/naturalSort.ts, so "Rack 10"
 * never lands before "Rack 2" again.
 *  (a) no `localeCompare(` outside portal/src/lib/naturalSort.ts;
 *  (b) no `new Intl.Collator(` outside that file;
 *  (c) no comparator-less `.sort()` or `.toSorted()` anywhere — pass
 *      naturalCompare / sortNatural for text, or compareOrdinal for machine
 *      strings (ISO timestamps, ids) whose code-unit order is the point.
 *      There is no allowlist: compareOrdinal makes the intent explicit.
 * Scans portal/src and kiosk/src, skipping *.test.ts / *.test.tsx and
 * comment lines (trimmed text starting with `//` or `*`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PORTAL_SRC = join(__dirname, '..');
const KIOSK_SRC = join(__dirname, '..', '..', '..', 'kiosk', 'src');
const COMPARATOR = 'lib/naturalSort.ts';

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

function scan(root: string, prefix: string): string[] {
  const out: string[] = [];
  for (const file of walk(root)) {
    const rel = `${prefix}${relative(root, file)}`;
    if (rel === `portal/src/${COMPARATOR}`) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      const trimmed = text.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      const line = i + 1;
      if (text.includes('localeCompare(')) out.push(`${rel}:${line}: localeCompare — use naturalCompare from lib/naturalSort`);
      if (text.includes('new Intl.Collator(')) out.push(`${rel}:${line}: Intl.Collator — use naturalCompare from lib/naturalSort`);
      if (/\.(sort|toSorted)\(\s*\)/.test(text)) {
        out.push(`${rel}:${line}: bare .sort()/.toSorted() — pass naturalCompare (text) or compareOrdinal (ISO timestamps, ids)`);
      }
    });
  }
  return out;
}

describe('natural sort guardrail', () => {
  it('every text ordering uses lib/naturalSort', () => {
    const violations = [...scan(PORTAL_SRC, 'portal/src/'), ...scan(KIOSK_SRC, 'kiosk/src/')];
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
