/** A space's `settings` as the API reads them (api/src/serversherpa/wiki/
 *  space_settings.py): the stored value, or the default when the space never
 *  set it. `SPACE_SETTING_DEFAULTS` mirrors that module's `DEFAULTS` — a test
 *  (spaceSettings.test.ts) reads the Python file and fails when they differ,
 *  so a new setting is added in both places. */
import type { SpaceOut } from './types';

export const SPACE_SETTING_DEFAULTS = {
  readers_can_comment: true as boolean,
  require_approval: false as boolean,
  review_interval_months: null as number | null,
  allow_public_links: false as boolean,
  allow_printing: true as boolean,
};

export type SpaceSettingKey = keyof typeof SPACE_SETTING_DEFAULTS;

export function spaceSetting<K extends SpaceSettingKey>(
  space: Pick<SpaceOut, 'settings'>, key: K,
): (typeof SPACE_SETTING_DEFAULTS)[K] {
  const v = space.settings?.[key];
  return v === undefined ? SPACE_SETTING_DEFAULTS[key] : (v as (typeof SPACE_SETTING_DEFAULTS)[K]);
}
