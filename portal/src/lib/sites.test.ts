import { describe, expect, it } from 'vitest';
import {
  afterSiteClientsFailure, formFromSite, formatCoords,
  naturalCompare, needsSiteCreate, sameClientSet, siteCellText,
  SITE_CREATED_UNLINKED_MESSAGE, SITE_ERRORS,
  SITE_GOD_FIELDS, siteSearchText, sitePayload, surveyPayload, surveySaveOps,
  type SiteFormState,
} from './sites';
import type { SiteItem, SurveySchema } from './api';

const site: SiteItem = {
  id: 's1', name: 'Acme DC1', code: 'ADC1',
  site_type: 'datacenter', type_label: 'Data centre', type_color: '#1668a7',
  status: 'active', status_label: 'Active', status_color: '#178a4c',
  address_line1: '1 Way', address_line2: null, city: 'Austin', region: 'TX',
  postal_code: '78701', country: 'US', latitude: 30.2672, longitude: -97.7431,
  timezone: 'America/Chicago', dc_provider: 'Switch',
  partner_id: null, partner_name: null, notes: null,
  archived_at: null, created_at: '2026-07-15T00:00:00Z',
  clients: [{ client_id: 'c1', name: 'Acme Co' }],
};

describe('siteCellText', () => {
  const blank: SiteItem = {
    ...site, code: null, type_label: null, city: null, dc_provider: null,
    address_line1: null, address_line2: null, region: null, postal_code: null,
    timezone: null, notes: null, latitude: null, longitude: null, clients: [],
  };

  it('primary combines name + code', () => {
    expect(siteCellText(site, 'primary')).toBe('Acme DC1 ADC1');
  });

  it('clients joins the linked-client names, dashing when empty', () => {
    expect(siteCellText(site, 'clients')).toBe('Acme Co');
    expect(siteCellText({ ...site, clients: [
      { client_id: 'c1', name: 'Acme Co' }, { client_id: 'c2', name: 'Beta Inc' },
    ] }, 'clients')).toBe('Acme Co, Beta Inc');
    expect(siteCellText(blank, 'clients')).toBe('—');
  });

  it('coords uses the formatCoords display string', () => {
    expect(siteCellText(site, 'coords')).toBe('30.2672, -97.7431');
    expect(siteCellText(blank, 'coords')).toBe('—');
  });

  it('latitude/longitude show the bare number, dashing when unset', () => {
    expect(siteCellText(site, 'latitude')).toBe('30.2672');
    expect(siteCellText(site, 'longitude')).toBe('-97.7431');
    expect(siteCellText(blank, 'latitude')).toBe('—');
    expect(siteCellText(blank, 'longitude')).toBe('—');
  });

  it('city/dc_provider/address/region/postal/timezone/notes dash when blank', () => {
    expect(siteCellText(site, 'city')).toBe('Austin');
    expect(siteCellText(blank, 'city')).toBe('—');
    expect(siteCellText(blank, 'dc_provider')).toBe('—');
    expect(siteCellText(blank, 'address_line1')).toBe('—');
    expect(siteCellText(blank, 'address_line2')).toBe('—');
    expect(siteCellText(blank, 'region')).toBe('—');
    expect(siteCellText(blank, 'postal_code')).toBe('—');
    expect(siteCellText(blank, 'timezone')).toBe('—');
    expect(siteCellText(blank, 'notes')).toBe('—');
  });

  it('country and status always read straight through (never blank)', () => {
    expect(siteCellText(site, 'country')).toBe('US');
    expect(siteCellText(site, 'status')).toBe('Active');
  });

  it('unknown column keys return empty string', () => {
    expect(siteCellText(site, 'nonsense')).toBe('');
  });
});

describe('siteSearchText', () => {
  it('includes name, code, city, provider and client names', () => {
    const text = siteSearchText(site);
    expect(text).toContain('acme dc1');
    expect(text).toContain('adc1');
    expect(text).toContain('austin');
    expect(text).toContain('switch');
    expect(text).toContain('acme co');
  });
});

describe('formatCoords', () => {
  it('formats a pair and handles absence', () => {
    expect(formatCoords(30.2672, -97.7431)).toBe('30.2672, -97.7431');
    expect(formatCoords(null, null)).toBe('—');
    expect(formatCoords(30.2672, null)).toBe('—');
  });
});

describe('sitePayload', () => {
  const base: SiteFormState = formFromSite(null);
  it('omits blanks and parses numbers', () => {
    const out = sitePayload({ ...base, name: ' New DC ', latitude: '30.2672',
                              longitude: '-97.7431', city: '' });
    expect(out).toEqual({ name: 'New DC', country: 'US',
                          latitude: 30.2672, longitude: -97.7431 });
  });
  it('sends null coords when both cleared', () => {
    const out = sitePayload({ ...formFromSite(site), latitude: '', longitude: '' });
    expect(out.latitude).toBeNull();
    expect(out.longitude).toBeNull();
  });
  it('half-set — latitude only sends the value and an explicit null longitude', () => {
    const out = sitePayload({ ...base, latitude: '30.2672', longitude: '' });
    expect(out).toEqual({ country: 'US', latitude: 30.2672, longitude: null });
  });
  it('half-set — longitude only sends the value and an explicit null latitude', () => {
    const out = sitePayload({ ...base, latitude: '', longitude: '-97.7431' });
    expect(out).toEqual({ country: 'US', latitude: null, longitude: -97.7431 });
  });
});

describe('surveyPayload', () => {
  const schema: SurveySchema = { groups: [{ key: 'dock', label: 'Dock', fields: [
    { key: 'dock_available', label: 'Dock available', kind: 'bool', options: [] },
    { key: 'dock_hours', label: 'Dock hours', kind: 'text', options: [] },
    { key: 'floor', label: 'Floor', kind: 'int', options: [] },
  ] }] };
  it('coerces by kind and drops blanks', () => {
    expect(surveyPayload({ dock_available: true, dock_hours: '  ',
                           floor: '3' }, schema))
      .toEqual({ dock_available: true, floor: 3 });
  });
  it('drops unknown keys rather than sending them', () => {
    expect(surveyPayload({ nope: 'x', dock_hours: '9-5' }, schema))
      .toEqual({ dock_hours: '9-5' });
  });
  it('drops unparseable ints', () => {
    expect(surveyPayload({ floor: 'abc' }, schema)).toEqual({});
  });
});

describe('surveySaveOps', () => {
  const schema: SurveySchema = { groups: [{ key: 'dock', label: 'Dock', fields: [
    { key: 'dock_available', label: 'Dock available', kind: 'bool', options: [] },
    { key: 'dock_hours', label: 'Dock hours', kind: 'text', options: [] },
    { key: 'floor', label: 'Floor', kind: 'int', options: [] },
  ] }] };

  it('a changed field produces exactly one put with the cleaned key+value', () => {
    const ops = surveySaveOps(
      { dock_hours: '9-5' }, { dock_hours: '8-6' }, schema);
    expect(ops.put).toEqual([['dock_hours', '8-6']]);
    expect(ops.clear).toEqual([]);
  });

  it('a field cleared (baseline answered, now empty) produces exactly one clear', () => {
    const ops = surveySaveOps(
      { dock_hours: '9-5' }, { dock_hours: '' }, schema);
    expect(ops.put).toEqual([]);
    expect(ops.clear).toEqual(['dock_hours']);
  });

  it('an untouched field produces no ops', () => {
    const ops = surveySaveOps(
      { dock_hours: '9-5', floor: 3 }, { dock_hours: '9-5', floor: 3 }, schema);
    expect(ops.put).toEqual([]);
    expect(ops.clear).toEqual([]);
  });

  it('a no-op edit that differs only pre-cleaning (whitespace) produces no ops', () => {
    const ops = surveySaveOps(
      { dock_hours: 'Dock A' }, { dock_hours: 'Dock A  ' }, schema);
    expect(ops.put).toEqual([]);
    expect(ops.clear).toEqual([]);
  });

  it('a no-op edit that differs only pre-cleaning (cosmetic int formatting) produces no ops', () => {
    const ops = surveySaveOps(
      { floor: 7 }, { floor: '007' }, schema);
    expect(ops.put).toEqual([]);
    expect(ops.clear).toEqual([]);
  });

  it('an explicitly-false bool that was false at baseline produces no ops', () => {
    // Current surveyPayload semantics: false = unanswered. Not changed here —
    // pinned as pre-existing behavior for a later task.
    const ops = surveySaveOps(
      { dock_available: false }, { dock_available: false }, schema);
    expect(ops.put).toEqual([]);
    expect(ops.clear).toEqual([]);
  });

  it('a bool flipped from unanswered to true produces one put', () => {
    const ops = surveySaveOps({}, { dock_available: true }, schema);
    expect(ops.put).toEqual([['dock_available', true]]);
    expect(ops.clear).toEqual([]);
  });

  it('a bool flipped from true to false produces one clear', () => {
    const ops = surveySaveOps(
      { dock_available: true }, { dock_available: false }, schema);
    expect(ops.put).toEqual([]);
    expect(ops.clear).toEqual(['dock_available']);
  });
});

describe('sameClientSet', () => {
  it('true for identical sets regardless of order', () => {
    expect(sameClientSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameClientSet([], [])).toBe(true);
  });
  it('false when sizes or members differ', () => {
    expect(sameClientSet(['a'], ['a', 'b'])).toBe(false);
    expect(sameClientSet(['a', 'b'], ['a', 'c'])).toBe(false);
  });
});

describe('needsSiteCreate', () => {
  it('create mode with nothing created yet → needs create', () => {
    expect(needsSiteCreate({ isCreateMode: true, createdId: null })).toBe(true);
  });
  it('edit mode never needs create', () => {
    expect(needsSiteCreate({ isCreateMode: false, createdId: null })).toBe(false);
  });
  it('NEVER re-creates once a site was created this session', () => {
    // Even though the modal is still nominally in "create mode", the
    // created id wins — a retry must not POST /sites a second time.
    expect(needsSiteCreate({ isCreateMode: true, createdId: 's-new' })).toBe(false);
  });
});

describe('afterSiteClientsFailure', () => {
  it('plain link failure (nothing created) → no message', () => {
    expect(afterSiteClientsFailure(null)).toBeNull();
  });
  it('created-but-unlinked → bare retry message', () => {
    expect(afterSiteClientsFailure('s-new')).toBe(SITE_CREATED_UNLINKED_MESSAGE);
  });
  it('appends the caller-mapped reason so permanent failures explain themselves', () => {
    expect(afterSiteClientsFailure('s-new', 'One of the selected clients no longer exists.'))
      .toBe(`${SITE_CREATED_UNLINKED_MESSAGE} One of the selected clients no longer exists.`);
  });
  it('still no message when nothing was created, reason or not', () => {
    expect(afterSiteClientsFailure(null, 'some reason')).toBeNull();
  });
});

/* ── god-edit descriptors ──────────────────────────────────────────── */

const SITE_WRITABLE_FIELDS = new Set([
  'name', 'code', 'site_type', 'status', 'city', 'region', 'postal_code',
  'country', 'address_line1', 'address_line2', 'timezone', 'dc_provider',
  'notes', 'latitude', 'longitude',
]);

describe('SITE_GOD_FIELDS', () => {
  const fields = SITE_GOD_FIELDS({
    types: () => [{ value: 'datacenter', label: 'Data centre' }],
    statuses: () => [{ value: 'active', label: 'Active' }],
  });

  it('only exposes fields on the writable allowlist', () => {
    for (const f of fields) expect(SITE_WRITABLE_FIELDS.has(f.field)).toBe(true);
    expect(fields.map((f) => f.field).sort()).toEqual([...SITE_WRITABLE_FIELDS].sort());
  });

  it('every fromRow round-trips a sample row', () => {
    const expected: Record<string, string> = {
      primary: 'Acme DC1', primary2: 'ADC1', type: 'datacenter', status: 'active',
      city: 'Austin', country: 'US', dc_provider: 'Switch',
      address_line1: '1 Way', address_line2: '', region: 'TX', postal_code: '78701',
      timezone: 'America/Chicago', notes: '', latitude: '30.2672', longitude: '-97.7431',
    };
    expect(fields.map((f) => f.column).sort()).toEqual(Object.keys(expected).sort());
    for (const f of fields) expect(f.fromRow(site)).toBe(expected[f.column]);
  });

  it('latitude/longitude use numberToPatch: blank clears, non-numeric throws', () => {
    const lat = fields.find((f) => f.column === 'latitude')!;
    const lon = fields.find((f) => f.column === 'longitude')!;
    expect(lat.toPatch?.('30.5')).toBe(30.5);
    expect(lat.toPatch?.('')).toBeNull();
    expect(() => lat.toPatch?.('abc')).toThrow('not_a_number');
    expect(lon.toPatch?.('-97.5')).toBe(-97.5);
    expect(lon.toPatch?.('')).toBeNull();
  });

  it('a null coordinate round-trips to an empty string, not "null"', () => {
    const noCoords = { ...site, latitude: null, longitude: null };
    const lat = fields.find((f) => f.column === 'latitude')!;
    const lon = fields.find((f) => f.column === 'longitude')!;
    expect(lat.fromRow(noCoords)).toBe('');
    expect(lon.fromRow(noCoords)).toBe('');
  });
});

describe('SITE_ERRORS', () => {
  it('is a non-empty error map covering the invalid_coordinates case', () => {
    expect(SITE_ERRORS.invalid_coordinates).toBeTruthy();
    expect(SITE_ERRORS.forbidden).toBeTruthy();
  });
});

describe('naturalCompare', () => {
  it('sorts embedded numbers numerically, not lexicographically', () => {
    const names = ['da10', 'da2', 'DA11', 'da1'];
    expect(names.sort(naturalCompare)).toEqual(['da1', 'da2', 'da10', 'DA11']);
  });
  it('is case-insensitive and stable for plain strings', () => {
    expect(['Zurich', 'austin', 'Reno'].sort(naturalCompare))
      .toEqual(['austin', 'Reno', 'Zurich']);
  });
  it('handles empty strings without throwing', () => {
    expect(['b', '', 'a'].sort(naturalCompare)).toEqual(['', 'a', 'b']);
  });
});
