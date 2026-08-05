import { describe, expect, it } from 'vitest';

import type { ExternalLinkItem, ExternalPersonItem } from './api';
import {
  CREATED_UNLINKED_MESSAGE,
  afterLinkFailure,
  buildLinkMetaPatch,
  buildNewContactPersonPayload,
  canEditExternalPerson,
  distinctFunctions,
  distinctTitles,
  externalFacetValues,
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

describe('externalFacetValues', () => {
  const p = person({
    links: [
      link({ kind: 'client', org_id: 'org-1', tier: 'admin', functions: ['billing'] }),
      link({ kind: 'partner', org_id: 'org-2', tier: 'viewer', functions: ['scheduling'] }),
    ],
    login_status: 'active',
  });

  it('orgType', () => expect(externalFacetValues('orgType', p)).toEqual(['client', 'partner']));
  it('org', () => expect(externalFacetValues('org', p)).toEqual(['client:org-1', 'partner:org-2']));
  it('tier', () => expect(externalFacetValues('tier', p)).toEqual(['admin', 'viewer']));
  it('function', () => expect(externalFacetValues('function', p)).toEqual(['billing', 'scheduling']));
  it('login', () => expect(externalFacetValues('login', p)).toEqual(['active']));
  it('unknown group', () => expect(externalFacetValues('bogus', p)).toEqual([]));
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
