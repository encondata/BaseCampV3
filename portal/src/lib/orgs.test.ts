import { describe, expect, it } from 'vitest';
import type { StatusValue } from './api';
import {
  effectiveStatus, ORG_ERRORS, ORG_GOD_FIELDS, orgCellText, partnerTypeColor, partnerTypeLabel,
  type OrgItem,
} from './orgs';

function statusValue(key: string, label: string, color: string): StatusValue {
  return {
    record_type: 'partner_type', key, label, description: '', color,
    sort_order: 0, is_active: true, usage_count: null, progress_weight: null,
  };
}

const org: OrgItem = {
  id: 'o1', name: 'Acme Co', code: 'ACME',
  partner_types: ['staffing'],
  status: 'active', tier: 'preferred', service_region: null,
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
  'name', 'code', 'status', 'tier', 'service_region', 'phone', 'website',
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
      primary: 'Acme Co', primary2: 'ACME', tier: 'preferred',
      service_region: '', status: 'active',
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
      service_region: null,
    };
    for (const col of ['primary2', 'phone', 'website', 'city', 'region',
      'postal_code', 'address_line1', 'address_line2', 'notes', 'service_region']) {
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

describe('effectiveStatus', () => {
  it('reads the raw status when not archived', () => {
    expect(effectiveStatus(org)).toBe('active');
  });
  it('archived_at overrides the raw status', () => {
    expect(effectiveStatus({ ...org, archived_at: '2026-01-01T00:00:00Z' })).toBe('archived');
  });
});

describe('orgCellText', () => {
  const blank: OrgItem = {
    ...org, code: null, city: null, region: null, website: null, phone: null,
    postal_code: null, address_line1: null, address_line2: null, notes: null,
    account_manager: null, partner_types: [],
  };

  it('primary combines name with a code · city/region secondary line', () => {
    expect(orgCellText(org, 'primary')).toBe('Acme Co ACME · Austin, TX');
    expect(orgCellText(blank, 'primary')).toBe('Acme Co');
  });

  it('type joins the partner-types labels, dashing when empty', () => {
    expect(orgCellText(org, 'type')).toBe('Staffing');
    expect(orgCellText({ ...org, partner_types: ['staffing', 'other'] }, 'type'))
      .toBe('Staffing, Other');
    expect(orgCellText(blank, 'type')).toBe('—');
  });

  it('type resolves labels from a supplied vocab map over the TYPE_LABEL fallback', () => {
    const vocab = new Map([['staffing', statusValue('staffing', 'Staffing Crew', '#123456')]]);
    expect(orgCellText(org, 'type', vocab)).toBe('Staffing Crew');
  });

  it('type falls back to TYPE_LABEL, then the raw key, for a key missing from the vocab', () => {
    const vocab = new Map([['tech', statusValue('tech', 'Tech', '#123456')]]);
    // 'staffing' isn't in this vocab map, so it falls to TYPE_LABEL's 'Staffing'.
    expect(orgCellText(org, 'type', vocab)).toBe('Staffing');
    // A retired/unknown key that TYPE_LABEL also doesn't know renders by its raw key.
    expect(orgCellText({ ...org, partner_types: ['retired_key'] }, 'type', vocab))
      .toBe('retired_key');
  });

  it('tier reads the raw key, unlabeled — matching the cell', () => {
    expect(orgCellText(org, 'tier')).toBe('preferred');
  });

  it('tier dashes when unset (partner rows, which never populate it)', () => {
    expect(orgCellText({ ...org, tier: null }, 'tier')).toBe('—');
  });

  it('service_region reads the raw freeform text, dashing when unset', () => {
    expect(orgCellText({ ...org, service_region: 'Southeast US' }, 'service_region'))
      .toBe('Southeast US');
    expect(orgCellText(org, 'service_region')).toBe('—');
  });

  it('status reads the STATUS_META label through effectiveStatus, so archived is selectable', () => {
    expect(orgCellText(org, 'status')).toBe('Active');
    expect(orgCellText({ ...org, archived_at: '2026-01-01T00:00:00Z' }, 'status')).toBe('Archived');
  });

  it('manager/website/phone/notes dash when unset', () => {
    expect(orgCellText(org, 'manager')).toBe('Jamie Rivera');
    expect(orgCellText(blank, 'manager')).toBe('—');
    expect(orgCellText(blank, 'website')).toBe('—');
    expect(orgCellText(blank, 'phone')).toBe('—');
    expect(orgCellText(blank, 'notes')).toBe('—');
  });

  it('contacts shows the bare rollup count', () => {
    expect(orgCellText(org, 'contacts')).toBe('3');
  });

  it('location joins city/region, dashing when both unset', () => {
    expect(orgCellText(org, 'location')).toBe('Austin, TX');
    expect(orgCellText(blank, 'location')).toBe('—');
  });

  it('country reads straight through (never blank)', () => {
    expect(orgCellText(org, 'country')).toBe('US');
  });

  it('unknown column keys return empty string', () => {
    expect(orgCellText(org, 'nonsense')).toBe('');
  });
});

describe('partnerTypeLabel', () => {
  it('prefers the vocab label when the key is present', () => {
    const vocab = new Map([['tech', statusValue('tech', 'Tech', '#123456')]]);
    expect(partnerTypeLabel('tech', vocab)).toBe('Tech');
  });

  it('falls back to TYPE_LABEL when the key is missing from the vocab', () => {
    expect(partnerTypeLabel('consultant', new Map())).toBe('Consultant');
  });

  it('falls back to the raw key when neither the vocab nor TYPE_LABEL know it', () => {
    expect(partnerTypeLabel('retired_key', new Map())).toBe('retired_key');
  });
});

describe('partnerTypeColor', () => {
  it('reads the color from the vocab when the key is present', () => {
    const vocab = new Map([['tech', statusValue('tech', 'Tech', '#123456')]]);
    expect(partnerTypeColor('tech', vocab)).toBe('#123456');
  });

  it('is undefined for a retired/unknown key, so callers leave --chip unset and directory.css supplies #51606f', () => {
    expect(partnerTypeColor('retired_key', new Map())).toBeUndefined();
  });
});

describe('ORG_ERRORS', () => {
  it('covers every code update_org can raise, plus the generic 403', () => {
    for (const code of [
      'name_or_code_in_use', 'manager_not_found', 'org_not_found',
      'name_required', 'status_required', 'tier_required', 'country_required',
      'tier_not_allowed', 'service_region_not_allowed', 'forbidden',
    ]) {
      expect(ORG_ERRORS[code]).toBeTruthy();
    }
  });
});
