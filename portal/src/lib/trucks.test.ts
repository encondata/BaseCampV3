import { describe, expect, it } from 'vitest';

import type { TruckDetail, TruckItem } from './api';
import {
  driversText, formFromTruck, parseLocationText, truckCellText,
  truckPayload, truckSearchText, updateAge,
} from './trucks';

const row: TruckItem = {
  id: 't1', legacy_id: null, name: 'Truck 12',
  driver_name: 'Ada Lovelace', co_driver_name: null, team_drive: false,
  contact_info: '555-1212',
  status: 'en_route', status_label: 'En route', status_color: '#178a4c',
  load_number: '1042', seal_id: 'SEAL-9',
  tracking_type: { type: 'gps', update_type: 'API', tracker_id: 'TRK-1' },
  initiative_id: 'i1', initiative_name: 'Denver DC migration',
  start_site_id: 's1', start_site_name: 'DC-East',
  end_site_id: 's2', end_site_name: 'DC-West',
  container_count: 3,
  last_update: {
    recorded_at: '2026-09-10T00:00:00Z', lat: 40.7, lng: -73.9,
    approximate_address: 'Newark, NJ',
  },
  archived_at: null, created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const detail: TruckDetail = {
  ...row,
  containers: [
    { id: 'c1', name: 'Crate A', status: 'available', status_label: 'Available', status_color: '#178a4c', asset_count: 2 },
  ],
};

describe('truckSearchText', () => {
  it('joins the searchable fields lowercased', () => {
    const t = truckSearchText(row);
    expect(t).toContain('truck 12');
    expect(t).toContain('ada lovelace');
    expect(t).toContain('1042');
    expect(t).toContain('seal-9');
    expect(t).toContain('en route');
    expect(t).toContain('denver dc migration');
    expect(t).toContain('dc-east');
    expect(t).toContain('dc-west');
    expect(t).toContain('newark, nj');
  });

  it('skips null/blank fields without leaving gaps', () => {
    const t = truckSearchText({
      ...row, co_driver_name: null, seal_id: null, last_update: null,
    });
    expect(t).not.toContain('null');
    expect(t).not.toContain('undefined');
  });
});

describe('driversText', () => {
  it('is empty with no driver', () => {
    expect(driversText({ ...row, driver_name: null })).toBe('');
  });
  it('shows the solo driver', () => {
    expect(driversText({ ...row, co_driver_name: null, team_drive: false }))
      .toBe('Ada Lovelace');
  });
  it('joins both drivers with +', () => {
    expect(driversText({ ...row, co_driver_name: 'Grace Hopper', team_drive: false }))
      .toBe('Ada Lovelace + Grace Hopper');
  });
  it('appends (team) when team_drive is set', () => {
    expect(driversText({ ...row, co_driver_name: 'Grace Hopper', team_drive: true }))
      .toBe('Ada Lovelace + Grace Hopper (team)');
  });
});

describe('truckCellText', () => {
  it('mirrors cell rendering including dashes', () => {
    expect(truckCellText(row, 'primary')).toBe('Truck 12 1042');
    expect(truckCellText(row, 'status')).toBe('En route');
    expect(truckCellText(row, 'drivers')).toBe('Ada Lovelace');
    expect(truckCellText(row, 'seal')).toBe('SEAL-9');
    expect(truckCellText(row, 'move')).toBe('Denver DC migration');
    expect(truckCellText(row, 'route')).toBe('DC-East → DC-West');
    expect(truckCellText(row, 'containers')).toBe('3');
    expect(truckCellText(row, 'unknown')).toBe('');
  });

  it('blanks routes and last-update show dashes/never', () => {
    expect(truckCellText({ ...row, start_site_name: null, end_site_name: null }, 'route'))
      .toBe('— → —');
    expect(truckCellText({ ...row, last_update: null }, 'last_update')).toBe('never');
  });
});

describe('updateAge', () => {
  it('is never for null', () => {
    expect(updateAge(null)).toBe('never');
  });
  it('renders a relative age for a timestamp', () => {
    expect(updateAge(new Date().toISOString())).not.toBe('never');
  });
});

describe('parseLocationText', () => {
  it('parses a valid "lat, lng" string with whitespace', () => {
    expect(parseLocationText(' 40.7 , -73.9 ')).toEqual({ lat: 40.7, lng: -73.9 });
  });
  it('rejects out-of-range values', () => {
    expect(parseLocationText('100, 50')).toBeNull();
    expect(parseLocationText('40, 200')).toBeNull();
  });
  it('rejects the wrong number of parts', () => {
    expect(parseLocationText('40.7, -73.9, 12')).toBeNull();
    expect(parseLocationText('40.7')).toBeNull();
  });
  it('rejects non-numeric parts', () => {
    expect(parseLocationText('abc, def')).toBeNull();
  });
  it('rejects blank parts', () => {
    expect(parseLocationText('40.7, ')).toBeNull();
    expect(parseLocationText(', -73.9')).toBeNull();
  });
});

describe('form round-trip', () => {
  it('builds a payload with nulls for cleared fields', () => {
    const form = formFromTruck(detail);
    expect(form.name).toBe('Truck 12');
    expect(form.type).toBe('gps');
    expect(form.update_type).toBe('API');
    expect(form.tracker_id).toBe('TRK-1');
    expect(form.initiative_id).toBe('i1');
    expect(form.container_ids).toEqual(['c1']);

    form.driver_name = '  ';
    form.seal_id = '';
    form.initiative_id = '';
    const p = truckPayload(form);
    expect(p.name).toBe('Truck 12');
    expect(p.driver_name).toBeNull();
    expect(p.seal_id).toBeNull();
    expect(p.initiative_id).toBeNull();
    expect(p.tracking_type).toEqual({ type: 'gps', update_type: 'API', tracker_id: 'TRK-1' });
    expect(p.contact_info).toBe('555-1212');
    expect(p.container_ids).toEqual(['c1']);
  });

  it('create mode starts with defaults', () => {
    const form = formFromTruck(null);
    expect(form.status).toBe('created');
    expect(form.name).toBe('');
    expect(form.team_drive).toBe(false);
    expect(form.container_ids).toEqual([]);
    expect(form.initiative_id).toBe('');
    expect(form.start_site_id).toBe('');
    expect(form.end_site_id).toBe('');
  });

  it('tracking_type collapses to {} when all three tracking strings are blank', () => {
    const form = formFromTruck(null);
    const p = truckPayload(form);
    expect(p.tracking_type).toEqual({});
  });

  it('contact_info blanks to "" not null (NOT NULL column)', () => {
    const form = formFromTruck(null);
    form.contact_info = '   ';
    const p = truckPayload(form);
    expect(p.contact_info).toBe('');
  });

  it('drops empty tracking keys but keeps present ones', () => {
    const form = formFromTruck(null);
    form.type = 'manual';
    const p = truckPayload(form);
    expect(p.tracking_type).toEqual({ type: 'manual' });
  });
});
