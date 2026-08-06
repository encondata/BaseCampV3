import { describe, expect, it } from 'vitest';

import type { ExternalLinkItem, ExternalPersonItem, PersonDetail } from './api';
import {
  CREATED_UNLINKED_MESSAGE,
  afterLinkFailure,
  applyExternalPatch,
  buildLinkMetaPatch,
  buildNewContactPersonPayload,
  canEditExternalPerson,
  distinctFunctions,
  distinctTitles,
  externalCellText,
  EXTERNAL_GOD_FIELDS,
  externalSearchHay,
  orgKey,
  parseOrgKey,
  planAddContact,
  typeLabel,
} from './external';

function link(overrides: Partial<ExternalLinkItem> = {}): ExternalLinkItem {
  return {
    kind: 'client',
    org_id: 'org-1',
    org_name: 'Acme',
    tier: 'admin',
    org_title: null,
    functions: [],
    ...overrides,
  };
}

function person(overrides: Partial<ExternalPersonItem> = {}): ExternalPersonItem {
  return {
    person_id: 'p-1',
    display_name: 'Jane Doe',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@acme.test',
    phone: null,
    avatar_url: null,
    has_login: false,
    login_status: 'none',
    links: [],
    ...overrides,
  };
}

describe('typeLabel', () => {
  it('empty links', () => {
    expect(typeLabel([])).toBe('—');
  });
  it('single kind', () => {
    expect(typeLabel([link({ kind: 'client' })])).toBe('Client');
    expect(typeLabel([link({ kind: 'partner' })])).toBe('Partner');
  });
  it('mixed kinds', () => {
    expect(typeLabel([link({ kind: 'client' }), link({ kind: 'partner', org_id: 'org-2' })]))
      .toBe('Both');
  });
});

describe('distinctTitles / distinctFunctions', () => {
  it('dedupes and drops nulls', () => {
    const links = [
      link({ org_title: 'VP Sales', functions: ['billing', 'escalation'] }),
      link({ org_id: 'org-2', org_title: 'VP Sales', functions: ['billing', 'scheduling'] }),
      link({ org_id: 'org-3', org_title: null, functions: [] }),
    ];
    expect(distinctTitles(links)).toEqual(['VP Sales']);
    expect(distinctFunctions(links)).toEqual(['billing', 'escalation', 'scheduling']);
  });
});

describe('externalCellText', () => {
  const withLinks = person({
    email: 'jane@acme.test',
    links: [
      link({ kind: 'client', org_id: 'org-1', org_name: 'Acme', tier: 'admin',
             org_title: 'VP Sales', functions: ['billing'] }),
      link({ kind: 'partner', org_id: 'org-2', org_name: 'Beta Corp', tier: 'viewer',
             org_title: 'VP Sales', functions: ['scheduling'] }),
    ],
    login_status: 'active',
  });
  const blank = person({ email: null, phone: null, links: [], login_status: 'none' });

  it('primary combines display_name + email/phone', () => {
    expect(externalCellText(withLinks, 'primary')).toBe('Jane Doe jane@acme.test');
    expect(externalCellText(person({ email: null, phone: '555-1212' }), 'primary'))
      .toBe('Jane Doe 555-1212');
    expect(externalCellText(blank, 'primary')).toBe('Jane Doe');
  });

  it('orgs joins each link\'s "org · tier", dashing when empty', () => {
    expect(externalCellText(withLinks, 'orgs')).toBe('Acme · admin, Beta Corp · viewer');
    expect(externalCellText(blank, 'orgs')).toBe('—');
  });

  it('type reads typeLabel', () => {
    expect(externalCellText(withLinks, 'type')).toBe('Both');
    expect(externalCellText(blank, 'type')).toBe('—');
  });

  it('title/functions dedupe+join, dashing when empty', () => {
    expect(externalCellText(withLinks, 'title')).toBe('VP Sales');
    expect(externalCellText(withLinks, 'functions')).toBe('billing, scheduling');
    expect(externalCellText(blank, 'title')).toBe('—');
    expect(externalCellText(blank, 'functions')).toBe('—');
  });

  it('email/phone dash when unset', () => {
    expect(externalCellText(withLinks, 'email')).toBe('jane@acme.test');
    expect(externalCellText(blank, 'email')).toBe('—');
    expect(externalCellText(blank, 'phone')).toBe('—');
  });

  it('login reads the same LOGIN_META label the chip shows', () => {
    expect(externalCellText(withLinks, 'login')).toBe('Active');
    expect(externalCellText(blank, 'login')).toBe('No login');
  });

  it('unknown column keys return empty string', () => {
    expect(externalCellText(withLinks, 'nonsense')).toBe('');
  });
});

describe('externalSearchHay', () => {
  it('folds name/email/org/title/function into one lowercase haystack', () => {
    const p = person({
      display_name: 'Jane Doe',
      email: 'Jane@Acme.test',
      links: [link({ org_name: 'Acme Corp', org_title: 'VP Sales', functions: ['Billing'] })],
    });
    const hay = externalSearchHay(p);
    expect(hay).toContain('jane doe');
    expect(hay).toContain('jane@acme.test');
    expect(hay).toContain('acme corp');
    expect(hay).toContain('vp sales');
    expect(hay).toContain('billing');
  });
});

describe('orgKey / parseOrgKey', () => {
  it('round-trips', () => {
    const key = orgKey('partner', 'abc-123');
    expect(key).toBe('partner:abc-123');
    expect(parseOrgKey(key)).toEqual({ kind: 'partner', orgId: 'abc-123' });
  });
});

describe('buildLinkMetaPatch', () => {
  it('returns null when both are empty', () => {
    expect(buildLinkMetaPatch('  ', [])).toBeNull();
  });
  it('includes only org_title when functions are empty', () => {
    expect(buildLinkMetaPatch('VP Sales', [])).toEqual({ org_title: 'VP Sales' });
  });
  it('includes only functions when title is blank', () => {
    expect(buildLinkMetaPatch('', ['billing'])).toEqual({ functions: ['billing'] });
  });
  it('includes both when set', () => {
    expect(buildLinkMetaPatch(' VP Sales ', ['billing'])).toEqual({
      org_title: 'VP Sales', functions: ['billing'],
    });
  });
});

describe('planAddContact', () => {
  it('picker mode links the picked person', () => {
    expect(planAddContact({ showNew: false, pick: 'p-9', createdPersonId: null }))
      .toEqual({ needsCreate: false, personId: 'p-9' });
  });
  it('create mode runs the create step first', () => {
    expect(planAddContact({ showNew: true, pick: '', createdPersonId: null }))
      .toEqual({ needsCreate: true, personId: '' });
  });
  it('NEVER re-creates once a person was created but not linked', () => {
    // Even if the modal were somehow still in create mode, the created
    // person wins — a retry must not POST /users a second time.
    expect(planAddContact({ showNew: true, pick: '', createdPersonId: 'p-new' }))
      .toEqual({ needsCreate: false, personId: 'p-new' });
    expect(planAddContact({ showNew: false, pick: 'p-other', createdPersonId: 'p-new' }))
      .toEqual({ needsCreate: false, personId: 'p-new' });
  });
});

describe('canEditExternalPerson', () => {
  const none = {
    canUsers: false, canClients: false, canPartners: false, canCreatePerson: false,
  };

  it('no perms at all → no Edit button', () => {
    expect(canEditExternalPerson(none, { login_status: 'none' })).toBe(false);
    expect(canEditExternalPerson(none, { login_status: 'active' })).toBe(false);
  });

  it('users:change alone qualifies (avatar is always editable)', () => {
    expect(canEditExternalPerson({ ...none, canUsers: true }, { login_status: 'active' }))
      .toBe(true);
  });

  // The regression this helper exists to prevent: org change perms must
  // grant link editing INDEPENDENTLY of users:change.
  it('an org change perm alone qualifies, without users:change', () => {
    expect(canEditExternalPerson({ ...none, canClients: true }, { login_status: 'active' }))
      .toBe(true);
    expect(canEditExternalPerson({ ...none, canPartners: true }, { login_status: 'active' }))
      .toBe(true);
  });

  it('users:add qualifies only while there is no login to grant', () => {
    const perms = { ...none, canCreatePerson: true };
    expect(canEditExternalPerson(perms, { login_status: 'none' })).toBe(true);
    expect(canEditExternalPerson(perms, { login_status: 'active' })).toBe(false);
    expect(canEditExternalPerson(perms, { login_status: 'disabled' })).toBe(false);
  });
});

describe('afterLinkFailure', () => {
  it('plain link failure (nothing created) → no state transition', () => {
    expect(afterLinkFailure(null)).toBeNull();
  });
  it('created-but-unlinked → picker mode, person pre-selected, retry message', () => {
    expect(afterLinkFailure('p-new')).toEqual({
      showNew: false,
      pick: 'p-new',
      message: CREATED_UNLINKED_MESSAGE,
    });
  });
  it('appends the caller-mapped reason so permanent failures explain themselves', () => {
    expect(afterLinkFailure('p-new', "You don't have permission for that tier.")).toEqual({
      showNew: false,
      pick: 'p-new',
      message: `${CREATED_UNLINKED_MESSAGE} You don't have permission for that tier.`,
    });
  });
  it('an unmappable code leaves the bare retry message untouched', () => {
    expect(afterLinkFailure('p-new', undefined)?.message).toBe(CREATED_UNLINKED_MESSAGE);
  });
  it('still no transition when nothing was created, reason or not', () => {
    expect(afterLinkFailure(null, 'some reason')).toBeNull();
  });
});

describe('buildNewContactPersonPayload', () => {
  it('trims fields and nulls out blanks, never creates an account', () => {
    expect(buildNewContactPersonPayload({
      first_name: ' Jane ', last_name: ' Doe ', email: '  ', phone: ' 555-1212 ',
    })).toEqual({
      first_name: 'Jane', last_name: 'Doe', contact_email: null, phone: '555-1212',
      roles: [], create_account: false,
    });
  });
});

// Fields admin_update_profile (PATCH /users/{person_id}/profile, api/src/
// serversherpa/api/routes/users.py) accepts via ProfileUpdateIn (api/src/
// serversherpa/api/schemas.py:199-216): first_name, last_name,
// preferred_name, email, phone, job_title, address_line1, address_line2,
// city, region, postal_code, country. Verified 1:1 against the schema;
// EXTERNAL_GOD_FIELDS must only ever name a field from this set.
const PROFILE_WRITABLE_FIELDS = new Set([
  'first_name', 'last_name', 'preferred_name', 'email', 'phone', 'job_title',
  'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country',
]);

function personDetail(overrides: Partial<PersonDetail> = {}): PersonDetail {
  return {
    id: 'p-1', first_name: 'Jane', last_name: 'Doe', preferred_name: null,
    display_name: 'Jane Doe', email: 'jane@acme.test', phone: '555-0100',
    job_title: null, address_line1: null, address_line2: null, city: null,
    region: null, postal_code: null, country: 'US', badge_uid: 'b-1',
    created_at: '2026-01-01T00:00:00Z', avatar_key: null, avatar_url: null,
    password_updated_at: null,
    ...overrides,
  };
}

describe('EXTERNAL_GOD_FIELDS', () => {
  const fields = EXTERNAL_GOD_FIELDS();

  it('only exposes fields the profile PATCH endpoint accepts', () => {
    for (const f of fields) expect(PROFILE_WRITABLE_FIELDS.has(f.field)).toBe(true);
  });

  it('exposes exactly phone, round-tripping a sample row', () => {
    expect(fields.map((f) => f.column)).toEqual(['phone']);
    expect(fields[0].fromRow(person({ phone: '555-1212' }))).toBe('555-1212');
  });

  it('falls back to empty string when phone is unset', () => {
    expect(fields[0].fromRow(person({ phone: null }))).toBe('');
  });

  it('deliberately has no descriptor for the guarded, compound, or derived columns', () => {
    for (const col of ['orgs', 'type', 'title', 'functions', 'email', 'login']) {
      expect(fields.some((f) => f.column === col)).toBe(false);
    }
  });
});

describe('applyExternalPatch', () => {
  it('merges phone from the server response', () => {
    const row = person({ phone: '555-1212' });
    const updated = applyExternalPatch(row, personDetail({ phone: '555-9999' }));
    expect(updated.phone).toBe('555-9999');
  });

  it('leaves unrelated fields untouched', () => {
    const row = person({ phone: '555-1212', login_status: 'active', links: [link()] });
    const updated = applyExternalPatch(row, personDetail({ phone: '555-9999' }));
    expect(updated.login_status).toBe('active');
    expect(updated.links).toEqual(row.links);
    expect(updated.display_name).toBe(row.display_name);
  });

  it('never mutates the input row', () => {
    const row = person({ phone: '555-1212' });
    const before = { ...row };
    applyExternalPatch(row, personDetail({ phone: '555-9999' }));
    expect(row).toEqual(before);
  });
});
