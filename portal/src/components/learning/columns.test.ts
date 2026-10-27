/** The Learning lists sit directly in .portal-page: their default columns
 *  (floors, gaps and padding summed by listGridStyle) must fit LIST_FIT.page
 *  at a 1512px viewport with the nav expanded. */
import { describe, expect, it } from 'vitest';

import { ACTIONS_TRACK, LIST_FIT, listGridStyle, type ColumnDef } from '../../lib/listTools';
import { LIBRARY_COLUMNS } from '../../pages/learning/LearningLibrary';
import { PACKET_COLUMNS } from '../../pages/learning/LearningPackets';
import { RULE_COLUMNS } from '../../pages/learning/LearningRules';
import { DRY_RUN_COLUMNS } from './DryRunPanel';
import { QUESTION_COLUMNS } from './QuizEditor';
import { SIGNOFF_COLUMNS } from './SignoffsPanel';
import { TRANSLATION_COLUMNS } from './TranslationsPanel';
import { VERSION_COLUMNS } from './VersionsPanel';

const defaults = (cols: ColumnDef[] | Record<string, ColumnDef>) =>
  (Array.isArray(cols) ? cols : Object.values(cols)).filter((c) => c.default);

describe('Learning list columns', () => {
  it.each([
    ['library', LIBRARY_COLUMNS],
    ['questions', QUESTION_COLUMNS],
    ['translations', TRANSLATION_COLUMNS],
    ['versions', VERSION_COLUMNS],
    ['sign-offs', SIGNOFF_COLUMNS],
    ['packets', PACKET_COLUMNS],
    ['dry run', DRY_RUN_COLUMNS],
  ] as const)('%s default columns fit .portal-page', (_name, cols) => {
    expect(listGridStyle(defaults(cols)).minWidth).toBeLessThanOrEqual(LIST_FIT.page);
  });

  it('rules fit .portal-page with their actions track', () => {
    expect(listGridStyle(defaults(RULE_COLUMNS), [ACTIONS_TRACK]).minWidth).toBeLessThanOrEqual(LIST_FIT.page);
  });

  it('every default column states its own px floor', () => {
    [LIBRARY_COLUMNS, QUESTION_COLUMNS, TRANSLATION_COLUMNS, VERSION_COLUMNS, SIGNOFF_COLUMNS,
      PACKET_COLUMNS, RULE_COLUMNS, DRY_RUN_COLUMNS]
      .flatMap((c) => defaults(c)).forEach((c) => expect(c.min).toBeGreaterThan(0));
  });
});
