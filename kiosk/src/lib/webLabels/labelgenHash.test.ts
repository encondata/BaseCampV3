/**
 * The TypeScript generator's hash, which the web kiosk's stored labels are
 * keyed on: vite.config.ts defines `__LABELGEN_HASH__` from exactly these
 * sources, and it moves with any of them but not with a test.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { LABELGEN_HASH } from './labelBuild';
import { labelgenSources, labelgenSourcesHash } from './labelgenHash';

const LABELGEN_DIR = join(__dirname, '../../labelgen');

let scratch: string | null = null;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

it("is the define vite.config.ts makes from labelgen's sources", () => {
  expect(__LABELGEN_HASH__).toMatch(/^[0-9a-f]{64}$/);
  expect(__LABELGEN_HASH__).toBe(labelgenSourcesHash(LABELGEN_DIR));
  expect(LABELGEN_HASH).toBe(__LABELGEN_HASH__);
});

it('covers every generator source and no test', () => {
  const files = labelgenSources(LABELGEN_DIR);
  expect(files).toEqual(expect.arrayContaining(['plan.ts', 'printing.ts', 'zpl.ts', 'index.ts', 'sourceHash.ts']));
  expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
  expect([...files].sort()).toEqual(files);
});

it('moves with a source, its name or a new source, and not with a test or a shadow file', () => {
  scratch = mkdtempSync(join(tmpdir(), 'labelgen-hash-'));
  const dir = scratch;
  writeFileSync(join(dir, 'plan.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'zpl.ts'), 'export const b = 2;\n');
  const base = labelgenSourcesHash(dir);
  expect(labelgenSourcesHash(dir)).toBe(base);

  writeFileSync(join(dir, 'plan.test.ts'), 'it("x", () => {});\n');
  writeFileSync(join(dir, '._plan.ts'), 'resource fork');
  writeFileSync(join(dir, 'notes.md'), '# not code');
  expect(labelgenSourcesHash(dir)).toBe(base);

  writeFileSync(join(dir, 'plan.ts'), 'export const a = 3;\n');
  const edited = labelgenSourcesHash(dir);
  expect(edited).not.toBe(base);

  writeFileSync(join(dir, 'extra.ts'), '');
  expect(labelgenSourcesHash(dir)).not.toBe(edited);
});
