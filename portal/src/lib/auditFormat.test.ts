import { describe, expect, it } from 'vitest';

import { entityHref } from './auditFormat';

const row = (entity_type: string, entity_id: string | null) =>
  ({ action: 'update', entity_type, entity_id, changes: {} });

describe('entityHref', () => {
  it('maps linkable record types to their list page with ?open=', () => {
    expect(entityHref(row('site', 's-1'))).toBe('/sites?open=s-1');
    expect(entityHref(row('worker', 'p-1'))).toBe('/people/workers?open=p-1');
    expect(entityHref(row('person', 'p-1'))).toBe('/people/users?open=p-1');
    expect(entityHref(row('user_account', 'p-1'))).toBe('/people/users?open=p-1');
    expect(entityHref(row('client', 'c-1'))).toBe('/stakeholders/clients?open=c-1');
    expect(entityHref(row('partner', 'v-1'))).toBe('/stakeholders/partners?open=v-1');
  });
  it('returns null for pageless types and missing ids', () => {
    expect(entityHref(row('auth', 'a@b.com'))).toBeNull();
    expect(entityHref(row('status_value', 'site:active'))).toBeNull();
    expect(entityHref(row('site', null))).toBeNull();
  });
});
