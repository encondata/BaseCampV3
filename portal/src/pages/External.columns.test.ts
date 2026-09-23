/** External has no existing test file to carry a rendered column-floors
 *  assertion (see recipe R7) — this asserts the pure computation instead.
 *  PRIMARY_COL/COLUMNS live in lib/external.ts (not External.tsx) so this
 *  stays cheap: importing the page module would drag in AvatarUpload/
 *  ComboBox/TagInput/TierSelect. */
import { describe, expect, it } from 'vitest';

import { COLUMNS, PRIMARY_COL } from '../lib/external';
import { listGridStyle } from '../lib/listTools';

describe('External columns', () => {
  it('default columns fit .portal-page at a 1512px window, nav expanded', () => {
    const defaults = [PRIMARY_COL, ...COLUMNS.filter((c) => c.default)];
    expect(listGridStyle(defaults, ['30px']).minWidth).toBeLessThanOrEqual(1176);
  });
});
