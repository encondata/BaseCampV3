import { ADMIN_RANK } from './access';

/** Who can read a note or a Notes & files attachment (api access/visibility.py). */
export type Visibility = 'everyone' | 'internal' | 'admin';

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  everyone: 'Everyone', internal: 'Internal', admin: 'Admin',
};

/** The levels this user may choose (and can see): clients only ever see
 *  Everyone; staff add Internal; Admin rank and up add Admin. */
export function visibilityOptions(isGlobal: boolean, maxRank: number): Visibility[] {
  if (!isGlobal) return ['everyone'];
  return maxRank >= ADMIN_RANK ? ['everyone', 'internal', 'admin'] : ['everyone', 'internal'];
}

/** Attachment kinds whose visibility is fixed at Everyone (api
 *  FIXED_VISIBILITY_KINDS): avatars/logos, and the report-definition files
 *  the report gather reads regardless of level. They get no Visibility button. */
export const FIXED_VISIBILITY_KINDS: ReadonlySet<string> = new Set([
  'avatar', 'survey_template', 'report_asset',
]);
