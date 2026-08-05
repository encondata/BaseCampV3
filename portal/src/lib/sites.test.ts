import { describe, expect, it } from 'vitest';
import {
  afterSiteClientsFailure, EMPTY_SITE_FILTERS, formFromSite, formatCoords, matchesSiteFilters,
  naturalCompare, needsSiteCreate, sameClientSet, SITE_CREATED_UNLINKED_MESSAGE, siteSearchText,
  sitePayload, surveyChanged, surveyPayload, type SiteFormState,
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

describe('matchesSiteFilters', () => {
  it('passes everything when empty', () => {
    expect(matchesSiteFilters(site, EMPTY_SITE_FILTERS)).toBe(true);
  });
  it('filters by type, status, client, country', () => {
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, type: ['office'] })).toBe(false);
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, type: ['datacenter'] })).toBe(true);
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, status: ['planned'] })).toBe(false);
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, client: ['c1'] })).toBe(true);
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, client: ['c2'] })).toBe(false);
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, country: ['CA'] })).toBe(false);
  });
  it('filters by coords presence', () => {
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, coords: ['yes'] })).toBe(true);
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, coords: ['no'] })).toBe(false);
    const noCoords = { ...site, latitude: null, longitude: null };
    expect(matchesSiteFilters(noCoords, { ...EMPTY_SITE_FILTERS, coords: ['no'] })).toBe(true);
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
  it('never includes survey_data', () => {
    expect('survey_data' in sitePayload(base)).toBe(false);
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

describe('surveyChanged', () => {
  const schema: SurveySchema = { groups: [{ key: 'dock', label: 'Dock', fields: [
    { key: 'dock_available', label: 'Dock available', kind: 'bool', options: [] },
    { key: 'dock_hours', label: 'Dock hours', kind: 'text', options: [] },
    { key: 'floor', label: 'Floor', kind: 'int', options: [] },
  ] }] };
  it('false when normalized answers are identical', () => {
    expect(surveyChanged({ dock_hours: '9-5' }, { dock_hours: '9-5  ' }, schema)).toBe(false);
  });
  it('false when both are effectively unanswered', () => {
    expect(surveyChanged({}, { dock_available: false, dock_hours: '' }, schema)).toBe(false);
  });
  it('true when a value actually changed', () => {
    expect(surveyChanged({ dock_hours: '9-5' }, { dock_hours: '24/7' }, schema)).toBe(true);
  });
  it('true when a field is newly answered', () => {
    expect(surveyChanged({}, { floor: '3' }, schema)).toBe(true);
  });
  it('ignores unknown keys on either side', () => {
    expect(surveyChanged({ nope: 'x' }, { nope: 'y' }, schema)).toBe(false);
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
