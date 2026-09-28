/**
 * Guardrail: text ordering goes through lib/naturalSort.ts, so "Rack 10"
 * never lands before "Rack 2" again.
 *  (a) no `localeCompare(` outside portal/src/lib/naturalSort.ts;
 *  (b) no `new Intl.Collator(` outside that file;
 *  (c) no comparator-less `.sort()` unless naturalSort.allow.json lists
 *      that file:line with a reason (numeric arrays, already-ordered input).
 * Scans portal/src and kiosk/src, skipping *.test.ts / *.test.tsx.
 * Violations print a ready-to-paste allowlist entry.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PORTAL_SRC = join(__dirname, '..');
const KIOSK_SRC = join(__dirname, '..', '..', '..', 'kiosk', 'src');
const COMPARATOR = 'lib/naturalSort.ts';

interface Allow { file: string; line: number; reason: string }
const allow: Allow[] = JSON.parse(readFileSync(join(__dirname, 'naturalSort.allow.json'), 'utf8'));

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
      const line = i + 1;
      if (text.includes('localeCompare(')) out.push(`${rel}:${line}: localeCompare — use naturalCompare from lib/naturalSort`);
      if (text.includes('new Intl.Collator(')) out.push(`${rel}:${line}: Intl.Collator — use naturalCompare from lib/naturalSort`);
      if (/\.sort\(\s*\)/.test(text) && !allow.some((a) => a.file === rel && a.line === line)) {
        out.push(`${rel}:${line}: bare .sort() — pass naturalCompare, or allowlist it:\n` +
          JSON.stringify({ file: rel, line, reason: '' }, null, 2));
      }
    });
  }
  return out;
}

describe('natural sort guardrail', () => {
  it('every text ordering uses lib/naturalSort', () => {
    const violations = [...scan(PORTAL_SRC, 'portal/src/'), ...scan(KIOSK_SRC, 'kiosk/src/')];
    expect(violations, violations.join('\n\n')).toEqual([]);
  });
  it('allowlist entries still point at a bare .sort()', () => {
    for (const a of allow) {
      const root = a.file.startsWith('kiosk/') ? join(KIOSK_SRC, '..', '..') : join(PORTAL_SRC, '..', '..');
      const text = readFileSync(join(root, a.file), 'utf8').split('\n')[a.line - 1] ?? '';
      expect(text, `${a.file}:${a.line} no longer has a bare .sort()`).toMatch(/\.sort\(\s*\)/);
    }
  });
});
