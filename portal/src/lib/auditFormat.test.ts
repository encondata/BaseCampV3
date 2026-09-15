import { describe, expect, it } from 'vitest';

import { actionLabel, entityHref, targetLabel } from './auditFormat';

const row = (entity_type: string, entity_id: string | null) =>
  ({ action: 'update', entity_type, entity_id, changes: {} });

describe('entityHref', () => {
  it('sends sites straight to their full-details page', () => {
    expect(entityHref(row('site', 's-1'))).toBe('/sites/s-1');
  });
  it('maps linkable record types to their list page with ?open=', () => {
    expect(entityHref(row('worker', 'p-1'))).toBe('/people/workers?open=p-1');
    expect(entityHref(row('person', 'p-1'))).toBe('/people/users?open=p-1');
    expect(entityHref(row('user_account', 'p-1'))).toBe('/people/users?open=p-1');
    expect(entityHref(row('client', 'c-1'))).toBe('/stakeholders/clients?open=c-1');
    expect(entityHref(row('partner', 'v-1'))).toBe('/stakeholders/partners?open=v-1');
    expect(entityHref(row('asset', 'as-1'))).toBe('/assets?open=as-1');
    expect(entityHref(row('asset_model', 'am-1'))).toBe('/assets/models?open=am-1');
    expect(entityHref(row('container', 'ct-1'))).toBe('/logistics/containers?open=ct-1');
  });
  it('returns null for pageless types and missing ids', () => {
    expect(entityHref(row('auth', 'a@b.com'))).toBeNull();
    expect(entityHref(row('status_value', 'site:active'))).toBeNull();
    expect(entityHref(row('site', null))).toBeNull();
  });
});

describe('labels', () => {
  it('names a kiosk printer factory reset', () => {
    expect(actionLabel({ ...row('device', 'd-1'), action: 'kiosk_printer_factory_reset' }))
      .toBe('Printer factory reset');
  });
  it('falls back to a readable action for anything unmapped', () => {
    expect(actionLabel({ ...row('device', 'd-1'), action: 'kiosk_printer_head_clean' }))
      .toBe('kiosk printer head clean');
  });
  it('names an access groups change', () => {
    expect(actionLabel({ ...row('person', 'p-1'), action: 'access_groups.set' }))
      .toBe('Changed access groups');
  });
  it('names a sign-out-everywhere action', () => {
    expect(actionLabel({ ...row('user_account', 'p-1'), action: 'session.revoke_all' }))
      .toBe('Signed out everywhere');
  });
  it("shows the kiosk's name as the target of a device row", () => {
    expect(targetLabel({ ...row('device', 'd-1'), entity_name: 'Dock Kiosk' }))
      .toBe("device 'Dock Kiosk'");
    expect(targetLabel(row('device', 'd-1'))).toBe('device');
  });
});
