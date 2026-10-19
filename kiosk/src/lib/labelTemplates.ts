/**
 * The move's label template set, as the last successful sync stored it
 * (`sync.ts` writes the `label_templates` store; see `localDb.ts`). Read
 * from IndexedDB only — no network — so printing works offline.
 */

import { sortNatural } from '@portal/lib/naturalSort';

import type { KioskLabelTemplate } from './api';
import { readKioskSetup } from './kioskSetup';
import { getAll, readMeta } from './localDb';

/** Every stored template, in natural name order (the order the API sends;
 *  IndexedDB hands rows back by id). Empty when the stored set belongs to
 *  a move other than the one the kiosk is set up for. Rejects when the
 *  database can't be opened, like the other `localDb` reads. */
export async function getLabelTemplates(): Promise<KioskLabelTemplate[]> {
  const setup = readKioskSetup();
  if (setup) {
    const owner = (await readMeta('label_templates'))?.initiativeId;
    if (owner !== undefined && owner !== setup.initiativeId) return [];
  }
  return sortNatural(await getAll<KioskLabelTemplate>('label_templates'), (t) => t.name);
}
