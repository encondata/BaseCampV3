/** The Learning lists sit directly in .portal-page: their default columns
 *  (floors, gaps and padding summed by listGridStyle) must fit LIST_FIT.page
 *  at a 1512px viewport with the nav expanded. */
import { describe, expect, it } from 'vitest';

import { LIST_FIT, listGridStyle, type ColumnDef } from '../../lib/listTools';
import { LIBRARY_COLUMNS } from '../../pages/learning/LearningLibrary';
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
  ] as const)('%s default columns fit .portal-page', (_name, cols) => {
    expect(listGridStyle(defaults(cols)).minWidth).toBeLessThanOrEqual(LIST_FIT.page);
  });

  it('every default column states its own px floor', () => {
    [LIBRARY_COLUMNS, QUESTION_COLUMNS, TRANSLATION_COLUMNS, VERSION_COLUMNS, SIGNOFF_COLUMNS]
      .flatMap((c) => defaults(c)).forEach((c) => expect(c.min).toBeGreaterThan(0));
  });
});
