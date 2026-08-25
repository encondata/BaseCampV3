import { describe, expect, it } from 'vitest';

import type { InitiativeItem } from './api';
import {
  formFromInitiative, initiativeCellText, initiativePayload,
  initiativeSearchText, sectionsForType,
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
