/**
 * The move's label template set, as the last successful sync stored it
 * (`sync.ts` writes the `label_templates` store; see `localDb.ts`). Read
 * from IndexedDB only — no network — so printing works offline.
 */

import { sortNatural } from '@portal/lib/naturalSort';

import type { KioskLabelTemplate } from './api';
import { getAll } from './localDb';

/** Every stored template, in natural name order (the order the API sends;
 *  IndexedDB hands rows back by id). Rejects when the database can't be
 *  opened, like the other `localDb` reads. */
export async function getLabelTemplates(): Promise<KioskLabelTemplate[]> {
  return sortNatural(await getAll<KioskLabelTemplate>('label_templates'), (t) => t.name);
}
