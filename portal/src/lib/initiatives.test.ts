import { describe, expect, it } from 'vitest';

import type { InitiativeItem } from './api';
import {
  formFromInitiative, initiativeCellText, initiativePayload,
  initiativeSearchText, partnerOptionsForRole, sectionsForType,
  siteOptionsForClient,
} from './initiatives';

const row: InitiativeItem = {
  id: 'i1', name: 'Denver DC migration', description: null,
  initiative_type: 'move', type_label: 'Move', type_color: '#a36207',
  sub_type: 'migration', sub_type_label: 'Migration', sub_type_color: '#0f7c86',
  status: 'in_progress', status_label: 'In progress', status_color: '#1668a7',
  client_id: 'c1', client_name: 'Acme', site_id: null, site_name: null,
  location: 'Denver, CO',
  scheduled_start: '2026-09-01T00:00:00Z', scheduled_end: null,
  sky_command_project_id: null,
  origin_site_id: 's1', origin_site_name: 'DC-East',
  destination_site_id: 's2', destination_site_name: 'DC-West',
  real_start_at: null, real_end_at: null, priority_devices: true,
  shipping_types: ['truck', 'rail'],
  shipping_partner_id: null, shipping_partner_name: null,
  origin_tech_partner_id: null, origin_cable_partner_id: null,
  origin_logistics_partner_id: null, destination_tech_partner_id: null,
  destination_cable_partner_id: null, destination_logistics_partner_id: null,
  origin_vendor_involved: null, destination_vendor_involved: null,
  people_count: 3, links_count: 1,
  archived_at: null, created_at: '2026-08-24T00:00:00Z',
};

describe('initiativeSearchText', () => {
  it('joins the searchable fields lowercased', () => {
    const t = initiativeSearchText(row);
    expect(t).toContain('denver dc migration');
    expect(t).toContain('move');
    expect(t).toContain('acme');
    expect(t).toContain('dc-east');
    expect(t).toContain('in progress');
  });
});

describe('initiativeCellText', () => {
  it('mirrors cell rendering including dashes', () => {
    expect(initiativeCellText(row, 'primary')).toBe('Denver DC migration');
    expect(initiativeCellText(row, 'type')).toBe('Move');
    expect(initiativeCellText(row, 'sub_type')).toBe('Migration');
    expect(initiativeCellText(row, 'status')).toBe('In progress');
    expect(initiativeCellText(row, 'client')).toBe('Acme');
    expect(initiativeCellText(row, 'site')).toBe('');
    expect(initiativeCellText(row, 'start')).toBe('2026-09-01');
    expect(initiativeCellText({ ...row, scheduled_start: null }, 'start'))
      .toBe('—');
    expect(initiativeCellText(row, 'origin')).toBe('DC-East');
    expect(initiativeCellText(row, 'people')).toBe('3');
    expect(initiativeCellText(row, 'archived')).toBe('No');
  });
});

describe('sectionsForType', () => {
  it('shows the project field only for projects, move block only for moves', () => {
    expect(sectionsForType('project')).toEqual({ project: true, move: false });
    expect(sectionsForType('move')).toEqual({ project: false, move: true });
    expect(sectionsForType('event')).toEqual({ project: false, move: false });
  });
});

describe('form round-trip', () => {
  it('defaults for create mode', () => {
    const f = formFromInitiative(null);
    expect(f.initiative_type).toBe('project');
    expect(f.status).toBe('planned');
    expect(f.shipping_types).toEqual([]);
    expect(f.priority_devices).toBe(false);
  });

  it('loads dates as YYYY-MM-DD and rebuilds a payload with nulls', () => {
    const f = formFromInitiative(row);
    expect(f.scheduled_start).toBe('2026-09-01');
    const p = initiativePayload({ ...f, location: '  ' });
    expect(p.name).toBe('Denver DC migration');
    expect(p.location).toBeNull();
    expect(p.scheduled_start).toBe('2026-09-01');
    expect(p.scheduled_end).toBeNull();
    expect(p.shipping_types).toEqual(['truck', 'rail']);
    expect(p.priority_devices).toBe(true);
  });
});

describe('siteOptionsForClient', () => {
  const site = (id: string, name: string, clientIds: string[],
                archived = false) => ({
    id, name, archived_at: archived ? '2026-01-01T00:00:00Z' : null,
    clients: clientIds.map((c) => ({ client_id: c, name: `Org ${c}` })),
  }) as unknown as import('./api').SiteItem;

  const sites = [
    site('s1', 'DC-East', ['acme']),
    site('s2', 'DC-West', []),
    site('s3', 'DC-North', ['acme']),
    site('s4', 'DC-Old', ['acme'], true),
  ];

  it('lists the selected client\'s sites first, everything still present', () => {
    const opts = siteOptionsForClient(sites, 'acme');
    expect(opts.map((o) => o.value)).toEqual(['s1', 's3', 's2']);
    expect(opts[0].sub).toBe('Client site');
    expect(opts[2].sub).toBeUndefined();
  });

  it('plain alphabetical-ish passthrough with no client selected', () => {
    const opts = siteOptionsForClient(sites, '');
    expect(opts.map((o) => o.value)).toEqual(['s1', 's2', 's3']);
    expect(opts.every((o) => o.sub === undefined)).toBe(true);
  });

  it('hides archived sites unless one is the current value', () => {
    expect(siteOptionsForClient(sites, 'acme').map((o) => o.value))
      .not.toContain('s4');
    expect(siteOptionsForClient(sites, 'acme', 's4').map((o) => o.value))
      .toContain('s4');
  });

  it('falls back to the plain list when the client has no assigned sites', () => {
    const opts = siteOptionsForClient(sites, 'globex');
    expect(opts.map((o) => o.value)).toEqual(['s1', 's2', 's3']);
    expect(opts.every((o) => o.sub === undefined)).toBe(true);
  });
});

describe('partnerOptionsForRole', () => {
  const partner = (id: string, name: string, tags: string[],
                   archived = false) => ({
    id, name, archived_at: archived ? '2026-01-01T00:00:00Z' : null,
    partner_types: tags,
  });

  const partners = [
    partner('p1', 'CableCo', ['Cable', 'Staffing']),
    partner('p2', 'FreightFast', ['Logistics']),
    partner('p3', 'GeneralCo', []),
    partner('p4', 'OldCable', ['Cable'], true),
  ];

  it('lists role-matching partners first, tagged with the matching function', () => {
    const opts = partnerOptionsForRole(partners, ['cable']);
    expect(opts.map((o) => o.value)).toEqual(['p1', 'p2', 'p3']);
    expect(opts[0].sub).toBe('Cable');
    expect(opts[1].sub).toBeUndefined();
  });

  it('shipping matches logistics-tagged partners too', () => {
    const opts = partnerOptionsForRole(partners, ['shipping', 'logistics']);
    expect(opts[0].value).toBe('p2');
    expect(opts[0].sub).toBe('Logistics');
  });

  it('plain list when nothing matches; archived hidden unless current', () => {
    const opts = partnerOptionsForRole(partners, ['tech']);
    expect(opts.map((o) => o.value)).toEqual(['p1', 'p2', 'p3']);
    expect(opts.every((o) => o.sub === undefined)).toBe(true);
    expect(partnerOptionsForRole(partners, ['cable'], 'p4').map((o) => o.value))
      .toContain('p4');
  });
});
