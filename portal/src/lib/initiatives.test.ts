import { describe, expect, it } from 'vitest';

import type { InitiativeAssetRow, InitiativeItem } from './api';
import {
  formFromInitiative, initiativeCellText, initiativePayload,
  initiativeSearchText, MOVE_ASSET_EDIT_FIELDS, moveAssetCellText, moveAssetProgress,
  partnerOptionsForRole, rackLayout, sectionsForType, siteOptionsForClient,
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

/* ── move assets ──────────────────────────────────────────────────── */

function assetRow(overrides: Partial<InitiativeAssetRow> = {}): InitiativeAssetRow {
  return {
    id: 'ia1', asset_id: 'a1',
    priority_wave: 'Wave 1', disposition: 'Relocate', owner: 'Jane Doe',
    source_rack: 'BJ08', source_ru: 12, source_verified: true,
    source_position: 'front',
    destination_rack: '11.01.01.01A.02', destination_ru: 8.5,
    destination_verified: false, destination_position: null,
    cable_info: 'patched', vendor_involved: true,
    status: 'racked', status_label: 'Racked', status_color: '#273FF5',
    created_at: '2026-08-20T00:00:00Z', updated_at: '2026-08-21T00:00:00Z',
    asset: {
      id: 'a1', legacy_id: 4021, serial_number: 'SN-001', name: 'Server A',
      rfid_tag: 'RFID-1', model_make: 'Dell', model_name: 'R740',
      ru_size: 2, location_detail: 'Row 3', client_name: 'Acme',
      status: 'active', status_label: 'Active', status_color: '#31F527',
    },
    ...overrides,
  };
}

describe('moveAssetProgress', () => {
  it('is all-zero for no rows', () => {
    expect(moveAssetProgress([])).toEqual({ complete: 0, total: 0, pct: 0 });
  });

  it('counts only status key "complete" across mixed statuses', () => {
    const rows = [
      assetRow({ status: 'complete' }),
      assetRow({ status: 'racked' }),
      assetRow({ status: 'complete' }),
      assetRow({ status: 'pre_stage' }),
    ];
    expect(moveAssetProgress(rows)).toEqual({ complete: 2, total: 4, pct: 50 });
  });

  it('is 100% when every row is complete', () => {
    const rows = [assetRow({ status: 'complete' }), assetRow({ status: 'complete' })];
    expect(moveAssetProgress(rows)).toEqual({ complete: 2, total: 2, pct: 100 });
  });
});

describe('moveAssetCellText', () => {
  it('reads default-column values, including nested asset fields', () => {
    const row = assetRow();
    expect(moveAssetCellText(row, 'asset_id')).toBe('4021');
    expect(moveAssetCellText(row, 'asset_name')).toBe('Server A');
    expect(moveAssetCellText(row, 'serial')).toBe('SN-001');
    expect(moveAssetCellText(row, 'make_model')).toBe('Dell R740');
    expect(moveAssetCellText(row, 'status')).toBe('Racked');
    expect(moveAssetCellText(row, 'source_rack')).toBe('BJ08');
    expect(moveAssetCellText(row, 'destination_rack')).toBe('11.01.01.01A.02');
  });

  it('renders RU numbers as plain strings, decimals included', () => {
    const row = assetRow({ source_ru: 12, destination_ru: 8.5 });
    expect(moveAssetCellText(row, 'source_ru')).toBe('12');
    expect(moveAssetCellText(row, 'destination_ru')).toBe('8.5');
  });

  it('falls back to — for missing RU', () => {
    const row = assetRow({ source_ru: null, destination_ru: null });
    expect(moveAssetCellText(row, 'source_ru')).toBe('—');
    expect(moveAssetCellText(row, 'destination_ru')).toBe('—');
  });

  it('renders booleans as Yes/No/—', () => {
    const yes = assetRow({ source_verified: true, destination_verified: false,
                           vendor_involved: null });
    expect(moveAssetCellText(yes, 'source_verified')).toBe('Yes');
    expect(moveAssetCellText(yes, 'destination_verified')).toBe('No');
    expect(moveAssetCellText(yes, 'vendor_involved')).toBe('—');
  });

  it('reads optional-column values, including nested asset fields', () => {
    const row = assetRow();
    expect(moveAssetCellText(row, 'wave')).toBe('Wave 1');
    expect(moveAssetCellText(row, 'disposition')).toBe('Relocate');
    expect(moveAssetCellText(row, 'owner')).toBe('Jane Doe');
    expect(moveAssetCellText(row, 'source_position')).toBe('front');
    expect(moveAssetCellText(row, 'destination_position')).toBe('—');
    expect(moveAssetCellText(row, 'cable_info')).toBe('patched');
    expect(moveAssetCellText(row, 'asset_status')).toBe('Active');
    expect(moveAssetCellText(row, 'rfid_tag')).toBe('RFID-1');
    expect(moveAssetCellText(row, 'location')).toBe('Row 3');
    expect(moveAssetCellText(row, 'client')).toBe('Acme');
    expect(moveAssetCellText(row, 'added')).toBe(new Date(row.created_at).toLocaleDateString());
    expect(moveAssetCellText(row, 'updated')).toBe(new Date(row.updated_at).toLocaleDateString());
  });

  it('falls back to — for missing nested/optional text fields', () => {
    const row = assetRow({
      priority_wave: null, disposition: null, owner: null,
      source_rack: null, destination_rack: null, cable_info: null,
      asset: { ...assetRow().asset, legacy_id: null, name: null,
                serial_number: null, model_make: null, model_name: null,
                rfid_tag: null, location_detail: null, client_name: null },
    });
    expect(moveAssetCellText(row, 'asset_id')).toBe('—');
    expect(moveAssetCellText(row, 'asset_name')).toBe('—');
    expect(moveAssetCellText(row, 'serial')).toBe('—');
    expect(moveAssetCellText(row, 'make_model')).toBe('—');
    expect(moveAssetCellText(row, 'wave')).toBe('—');
    expect(moveAssetCellText(row, 'disposition')).toBe('—');
    expect(moveAssetCellText(row, 'owner')).toBe('—');
    expect(moveAssetCellText(row, 'source_rack')).toBe('—');
    expect(moveAssetCellText(row, 'destination_rack')).toBe('—');
    expect(moveAssetCellText(row, 'cable_info')).toBe('—');
    expect(moveAssetCellText(row, 'rfid_tag')).toBe('—');
    expect(moveAssetCellText(row, 'location')).toBe('—');
    expect(moveAssetCellText(row, 'client')).toBe('—');
  });

  it('returns empty string for an unknown column key', () => {
    expect(moveAssetCellText(assetRow(), 'nonsense')).toBe('');
  });
});

describe('MOVE_ASSET_EDIT_FIELDS', () => {
  const lookups = { statuses: () => [{ value: 'racked', label: 'Racked' }] };
  const fields = MOVE_ASSET_EDIT_FIELDS(lookups);
  const fieldFor = (column: string) => fields.find((f) => f.column === column)!;

  it('covers exactly the 13 per-move fields, none of the asset-identity columns', () => {
    expect(fields.map((f) => f.column).sort()).toEqual([
      'cable_info', 'destination_position', 'destination_rack', 'destination_ru',
      'destination_verified', 'disposition', 'owner', 'source_position',
      'source_rack', 'source_ru', 'source_verified', 'status', 'vendor_involved',
      'wave',
    ].sort());
  });

  it('maps tri-state booleans to yes/no/blank for fromRow, and back via toPatch', () => {
    const verified = fieldFor('source_verified');
    expect(verified.fromRow(assetRow({ source_verified: true }))).toBe('yes');
    expect(verified.fromRow(assetRow({ source_verified: false }))).toBe('no');
    expect(verified.fromRow(assetRow({ source_verified: null }))).toBe('');
    expect(verified.toPatch?.('yes')).toBe(true);
    expect(verified.toPatch?.('no')).toBe(false);
    expect(verified.toPatch?.('')).toBeNull();

    const vendor = fieldFor('vendor_involved');
    expect(vendor.fromRow(assetRow({ vendor_involved: null }))).toBe('');
    expect(vendor.fromRow(assetRow({ vendor_involved: true }))).toBe('yes');
  });

  it('round-trips RU numbers as plain strings, blank for null, rejects non-numbers', () => {
    const ru = fieldFor('source_ru');
    expect(ru.fromRow(assetRow({ source_ru: 8.5 }))).toBe('8.5');
    expect(ru.fromRow(assetRow({ source_ru: null }))).toBe('');
    expect(ru.toPatch?.('12')).toBe(12);
    expect(ru.toPatch?.('')).toBeNull();
    expect(() => ru.toPatch?.('abc')).toThrow();
  });

  it('status is a select field sourced from the passed-in lookup', () => {
    const status = fieldFor('status');
    expect(status.kind).toBe('select');
    expect(status.fromRow(assetRow({ status: 'complete' }))).toBe('complete');
    expect(status.options?.()).toEqual([{ value: 'racked', label: 'Racked' }]);
  });

  it('plain text fields pass row values straight through, blank for null', () => {
    expect(fieldFor('wave').fromRow(assetRow({ priority_wave: 'Wave 2' }))).toBe('Wave 2');
    expect(fieldFor('wave').fromRow(assetRow({ priority_wave: null }))).toBe('');
    expect(fieldFor('owner').fromRow(assetRow({ owner: null }))).toBe('');
    expect(fieldFor('disposition').fromRow(assetRow({ disposition: null }))).toBe('');
    expect(fieldFor('source_rack').fromRow(assetRow({ source_rack: null }))).toBe('');
    expect(fieldFor('destination_rack').fromRow(assetRow({ destination_rack: null }))).toBe('');
    expect(fieldFor('source_position').fromRow(assetRow({ source_position: null }))).toBe('');
    expect(fieldFor('destination_position')
      .fromRow(assetRow({ destination_position: null }))).toBe('');
    expect(fieldFor('cable_info').fromRow(assetRow({ cable_info: null }))).toBe('');
  });
});

/* ── rack view (Task 6) — pure placement math the RackViewModal renders
      from; TDD'd here per the plan since pages stay thin. ────────────── */

describe('rackLayout', () => {
  it('matches only rows whose rack+side equals the requested name, with a non-null RU', () => {
    const rows = [
      assetRow({ id: 'a', source_rack: 'BJ08', source_ru: 10 }),
      assetRow({ id: 'b', source_rack: 'BJ08', source_ru: null }), // no RU — excluded
      assetRow({ id: 'c', source_rack: 'OTHER', source_ru: 5 }), // wrong rack — excluded
      assetRow({ id: 'd', source_rack: null, source_ru: null,
                 destination_rack: 'BJ08', destination_ru: 3 }), // wrong side
    ];
    expect(rackLayout(rows, 'BJ08', 'source').map((b) => b.id)).toEqual(['a']);
  });

  it('reads the matching side\'s rack/RU (not the other side\'s)', () => {
    const rows = [
      assetRow({ id: 'a', source_rack: 'BJ08', source_ru: 10,
                 destination_rack: 'BJ08', destination_ru: 20 }),
    ];
    expect(rackLayout(rows, 'BJ08', 'destination').map((b) => b.ru)).toEqual([20]);
  });

  it('passes decimal RU values through unchanged', () => {
    const rows = [assetRow({ id: 'a', source_rack: 'BJ08', source_ru: 8.5 })];
    expect(rackLayout(rows, 'BJ08', 'source')[0].ru).toBe(8.5);
  });

  it('defaults block height to 1 when the asset model has no ru_size', () => {
    const rows = [assetRow({
      id: 'a', source_rack: 'BJ08', source_ru: 10,
      asset: { ...assetRow().asset, ru_size: null },
    })];
    expect(rackLayout(rows, 'BJ08', 'source')[0].height).toBe(1);
  });

  it('uses the asset model ru_size as block height when present', () => {
    const rows = [assetRow({
      id: 'a', source_rack: 'BJ08', source_ru: 10,
      asset: { ...assetRow().asset, ru_size: 4 },
    })];
    expect(rackLayout(rows, 'BJ08', 'source')[0].height).toBe(4);
  });

  it('maps the matching side\'s verified flag and position note', () => {
    const rows = [assetRow({
      id: 'a', source_rack: 'BJ08', source_ru: 10,
      source_verified: true, source_position: 'front',
      destination_verified: false, destination_position: 'rear',
    })];
    const [block] = rackLayout(rows, 'BJ08', 'source');
    expect(block.verified).toBe(true);
    expect(block.position).toBe('front');
  });

  it('treats a null verified flag as unverified (not throwing)', () => {
    const rows = [assetRow({
      id: 'a', source_rack: 'BJ08', source_ru: 10, source_verified: null,
    })];
    expect(rackLayout(rows, 'BJ08', 'source')[0].verified).toBe(false);
  });

  it('labels a block with the asset name, falling back to serial when unnamed', () => {
    const rows = [
      assetRow({ id: 'a', source_rack: 'BJ08', source_ru: 10,
                 asset: { ...assetRow().asset, name: 'Server A' } }),
      assetRow({ id: 'b', source_rack: 'BJ08', source_ru: 11,
                 asset: { ...assetRow().asset, name: null, serial_number: 'SN-9' } }),
    ];
    const blocks = rackLayout(rows, 'BJ08', 'source');
    expect(blocks.find((b) => b.id === 'a')?.label).toBe('Server A');
    expect(blocks.find((b) => b.id === 'b')?.label).toBe('SN-9');
  });
});
