import { describe, expect, it } from 'vitest';
import { ORG_ERRORS, ORG_GOD_FIELDS, type OrgItem } from './orgs';

const org: OrgItem = {
  id: 'o1', name: 'Acme Co', code: 'ACME',
  partner_types: ['staffing'],
  status: 'active', tier: 'preferred',
  phone: '555-0100', website: 'https://acme.example',
  address_line1: '1 Way', address_line2: null,
  city: 'Austin', region: 'TX', postal_code: '78701', country: 'US',
  notes: null,
  account_manager: { id: 'p1', display_name: 'Jamie Rivera' },
  contact_count: 3, logo_url: null,
  archived_at: null, created_at: '2026-07-15T00:00:00Z',
};

/* Fields OrgUpdateIn (api/src/serversherpa/api/routes/stakeholders.py:367-385)
 * accepts, minus account_manager_id (renamed by update_org to
 * "account_manager" for its own diffing, but the wire field the client
 * sends is account_manager_id) and partner_types — both deliberately
 * excluded from god-edit (see ORG_GOD_FIELDS' doc comment). Verified 1:1
 * against the schema; ORG_GOD_FIELDS must only ever name a field from
 * this writable set. */
const ORG_WRITABLE_FIELDS = new Set([
  'name', 'code', 'status', 'tier', 'phone', 'website',
  'address_line1', 'address_line2', 'city', 'region', 'postal_code',
  'country', 'notes',
]);

describe('ORG_GOD_FIELDS', () => {
  const fields = ORG_GOD_FIELDS();

  it('only exposes fields on the OrgUpdateIn writable allowlist', () => {
    for (const f of fields) expect(ORG_WRITABLE_FIELDS.has(f.field)).toBe(true);
    expect(fields.map((f) => f.field).sort()).toEqual([...ORG_WRITABLE_FIELDS].sort());
  });

  it('every fromRow round-trips a sample row', () => {
    const expected: Record<string, string> = {
      primary: 'Acme Co', primary2: 'ACME', tier: 'preferred', status: 'active',
      phone: '555-0100', website: 'https://acme.example',
      city: 'Austin', region: 'TX', postal_code: '78701', country: 'US',
      address_line1: '1 Way', address_line2: '', notes: '',
    };
    expect(fields.map((f) => f.column).sort()).toEqual(Object.keys(expected).sort());
    for (const f of fields) expect(f.fromRow(org)).toBe(expected[f.column]);
  });

  it('nullable text fields fall back to empty string when unset', () => {
    const bare: OrgItem = {
      ...org, code: null, phone: null, website: null,
      city: null, region: null, postal_code: null,
      address_line1: null, address_line2: null, notes: null,
    };
    for (const col of ['primary2', 'phone', 'website', 'city', 'region',
      'postal_code', 'address_line1', 'address_line2', 'notes']) {
      const f = fields.find((x) => x.column === col)!;
      expect(f.fromRow(bare)).toBe('');
    }
  });

  it('tier and status expose the correct static options', () => {
    const tier = fields.find((f) => f.column === 'tier')!;
    const status = fields.find((f) => f.column === 'status')!;
    expect(tier.options?.().map((o) => o.value)).toEqual(['standard', 'preferred', 'strategic']);
    expect(status.options?.().map((o) => o.value)).toEqual(['prospect', 'active', 'dormant']);
  });

  it('deliberately has no descriptor for type, manager, or rollup columns', () => {
    for (const col of ['type', 'manager', 'contacts', 'created', 'archived']) {
      expect(fields.some((f) => f.column === col)).toBe(false);
    }
  });
});

describe('ORG_ERRORS', () => {
  it('covers every code update_org can raise, plus the generic 403', () => {
    for (const code of [
      'name_or_code_in_use', 'manager_not_found', 'org_not_found',
      'name_required', 'status_required', 'tier_required', 'country_required', 'forbidden',
    ]) {
      expect(ORG_ERRORS[code]).toBeTruthy();
    }
  });
});
