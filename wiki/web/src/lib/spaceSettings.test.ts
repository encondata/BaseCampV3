import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { SpaceOut } from './types';
import { SPACE_SETTING_DEFAULTS, spaceSetting } from './spaceSettings';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const API_SETTINGS = resolve(SRC, '../../../api/src/serversherpa/wiki/space_settings.py');

/** The API's `DEFAULTS` dict, read from its source: key -> JSON value. */
function apiDefaults(): Record<string, unknown> {
  const source = readFileSync(API_SETTINGS, 'utf8');
  const block = source.match(/^DEFAULTS[^{]*\{([\s\S]*?)^\}/m);
  if (!block) throw new Error('DEFAULTS not found in space_settings.py');
  const out: Record<string, unknown> = {};
  for (const [, key, value] of block[1].matchAll(/"(\w+)":\s*(True|False|None|-?\d+|"[^"\n]*")/g)) {
    out[key] = value === 'True' ? true : value === 'False' ? false : value === 'None' ? null
      : value.startsWith('"') ? value.slice(1, -1) : Number(value);
  }
  return out;
}

const space = (settings: Record<string, unknown>) => ({ settings }) as unknown as SpaceOut;

describe('space settings', () => {
  it('has the same keys and defaults as the API (space_settings.DEFAULTS)', () => {
    expect(SPACE_SETTING_DEFAULTS).toEqual(apiDefaults());
  });

  it('reads the stored value, or the default when the space never set it', () => {
    expect(spaceSetting(space({}), 'readers_can_comment')).toBe(true);
    expect(spaceSetting(space({ readers_can_comment: false }), 'readers_can_comment')).toBe(false);
    expect(spaceSetting(space({}), 'review_interval_months')).toBeNull();
    expect(spaceSetting(space({ review_interval_months: 6 }), 'review_interval_months')).toBe(6);
    expect(spaceSetting(space({}), 'confidentiality_statement')).toBe('');
    expect(spaceSetting(space({ confidentiality_statement: 'Hush' }), 'confidentiality_statement')).toBe('Hush');
  });
});
