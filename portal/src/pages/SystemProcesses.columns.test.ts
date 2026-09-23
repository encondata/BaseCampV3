/** SystemProcesses renders inside the router and the auth shell, and the
 *  page has no test file of its own, so the fit check runs against the pure
 *  column registry in lib/system.ts rather than a rendered assertion — see
 *  recipe R7. */
import { describe, expect, it } from 'vitest';

import { LIST_FIT, listGridStyle } from '../lib/listTools';
import { SYSTEM_PROCESS_COLUMNS } from '../lib/system';

describe('SystemProcesses columns', () => {
  it('default columns fit .portal-page at a 1512px window, nav expanded', () => {
    const defaults = SYSTEM_PROCESS_COLUMNS.filter((c) => c.default);
    expect(listGridStyle(defaults).minWidth).toBeLessThanOrEqual(LIST_FIT.page);
  });
});
