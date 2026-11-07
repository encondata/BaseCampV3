import { describe, expect, it } from 'vitest';

import type { AssignFlagKind } from './api';
import { ASSIGN_BULK_ERRORS, ASSIGN_COLUMN_GUIDE, FLAG_TEXT } from './assignBulk';

describe('assign bulk copy', () => {
  it('lists exactly the API columns, names required', () => {
    expect(ASSIGN_COLUMN_GUIDE.map((c) => c.key))
      .toEqual(['first_name', 'last_name', 'preferred_name', 'phone', 'email', 'role']);
    expect(ASSIGN_COLUMN_GUIDE.filter((c) => c.required).map((c) => c.key))
      .toEqual(['first_name', 'last_name']);
  });
  it('has a sentence for every flag kind', () => {
    const kinds: AssignFlagKind[] = ['needs_match', 'role_unknown', 'name_differs', 'contact', 'partner',
      'status', 'assignment', 'shared_contact', 'no_contact', 'phone_invalid'];
    for (const k of kinds) expect(FLAG_TEXT[k]).toBeTruthy();
    expect(Object.keys(FLAG_TEXT).sort()).toEqual([...kinds].sort());
  });
  it('maps the new error codes', () => {
    for (const c of ['invalid_decisions', 'partner_not_found', 'partner_archived', 'site_not_found',
      'site_archived', 'initiative_archived', 'rows_invalid']) {
      expect(ASSIGN_BULK_ERRORS[c]).toBeTruthy();
    }
    expect(ASSIGN_BULK_ERRORS.partner_archived).toBe('That partner is archived — pick another.');
  });
});
