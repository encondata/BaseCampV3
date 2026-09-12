import { describe, expect, it } from 'vitest';

import type { ContainerItem } from './api';
import {
  containerCellText, containerGroupKey, containerGroupKeys, containerPayload,
  containerSearchText, formFromContainer, groupContainers, NO_INITIATIVE_KEY,
  type ContainerGroupRow, type ContainerItemRow,
} from './containers';

const row: ContainerItem = {
  id: 'c1', name: 'Crate A', rfid_tag: 'RF-9',
  container_type: 'cart', type_label: 'Cart', type_color: '#0f7c86',
  status: 'available', status_label: 'Available', status_color: '#178a4c',
  site_id: 's1', site_name: 'DC-East', location_detail: 'Dock 3',
  asset_count: 4, last_audit_at: null, last_validated_at: null,
  archived_at: null, created_at: '2026-08-06T00:00:00Z',
};

describe('containerSearchText', () => {
  it('joins the searchable fields lowercased', () => {
    const t = containerSearchText(row);
    expect(t).toContain('crate a');
    expect(t).toContain('rf-9');
    expect(t).toContain('dc-east');
    expect(t).toContain('cart');
  });

  it('includes the label tag\'s own text, so the global search box can find it', () => {
    expect(containerSearchText({ ...row, label_tag: 'priority' })).toContain('priority');
    expect(containerSearchText({ ...row, label_tag: 'ewaste' })).toContain('e-waste');
  });

  it('carries no extra text when untagged', () => {
    expect(containerSearchText(row)).not.toContain('undefined');
    expect(containerSearchText(row)).not.toContain('null');
  });
});

describe('containerCellText', () => {
  it('mirrors cell rendering including dashes', () => {
    expect(containerCellText(row, 'primary')).toBe('Crate A');
    expect(containerCellText(row, 'type')).toBe('Cart');
    expect(containerCellText(row, 'status')).toBe('Available');
    expect(containerCellText(row, 'site')).toBe('DC-East');
    expect(containerCellText(row, 'assets')).toBe('4');
    expect(containerCellText({ ...row, rfid_tag: null }, 'rfid')).toBe('—');
    expect(containerCellText(row, 'archived')).toBe('No');
    expect(containerCellText({ ...row, initiative_name: 'NAP11 Hall Migration' }, 'initiative'))
      .toBe('NAP11 Hall Migration');
    expect(containerCellText(row, 'initiative')).toBe('');
  });
});

describe('containerCellText label_tag', () => {
  it('shows the tag\'s own label, and empty when none is set', () => {
    expect(containerCellText({ ...row, label_tag: 'priority' }, 'label_tag')).toBe('Priority');
    expect(containerCellText({ ...row, label_tag: 'ewaste' }, 'label_tag')).toBe('E-Waste');
    expect(containerCellText(row, 'label_tag')).toBe('');
    expect(containerCellText({ ...row, label_tag: null }, 'label_tag')).toBe('');
  });
});

describe('form round-trip', () => {
  it('builds a payload with nulls for cleared fields', () => {
    const form = formFromContainer(row);
    form.rfid_tag = '  ';
    form.site_id = '';
    const p = containerPayload(form);
    expect(p.name).toBe('Crate A');
    expect(p.rfid_tag).toBeNull();
    expect(p.site_id).toBeNull();
    expect(p.status).toBe('available');
  });
  it('create mode starts with defaults', () => {
    const form = formFromContainer(null);
    expect(form.status).toBe('available');
    expect(form.name).toBe('');
  });
});

describe('containerCellText rfid', () => {
  it('shows the EPC without its zero padding', () => {
    expect(containerCellText({ ...row, rfid_tag: '000000000000000000100204' }, 'rfid')).toBe('100204');
    expect(containerCellText({ ...row, rfid_tag: null }, 'rfid')).toBe('—');
  });
});

describe('groupContainers', () => {
  const a = { ...row, id: 'a1', name: 'Alpha Crate', initiative_id: 'i-alpha', initiative_name: 'Alpha Migration' };
  const a2 = { ...row, id: 'a2', name: 'Alpha Crate 2', initiative_id: 'i-alpha', initiative_name: 'Alpha Migration', archived_at: '2026-01-01T00:00:00Z' };
  const b = { ...row, id: 'b1', name: 'Bravo Crate', initiative_id: 'i-bravo', initiative_name: 'Bravo Migration' };
  const none = { ...row, id: 'n1', name: 'Loose Crate', initiative_id: null, initiative_name: null };
  const all: ContainerItem[] = [a, a2, b, none];

  it('partitions rows by initiative_id into one group per initiative', () => {
    const rows = groupContainers(all, new Set());
    const groups = rows.filter((r): r is ContainerGroupRow => r.kind === 'group');
    expect(groups.map((g) => g.key)).toEqual(['i-alpha', 'i-bravo', NO_INITIATIVE_KEY]);
  });

  it('orders groups by initiative name, with No initiative last', () => {
    const rows = groupContainers([b, a, none], new Set());
    const groups = rows.filter((r): r is ContainerGroupRow => r.kind === 'group');
    expect(groups.map((g) => g.label)).toEqual(['Alpha Migration', 'Bravo Migration', 'No initiative']);
  });

  it('counts containers per group, including an archived sub-count', () => {
    const rows = groupContainers(all, new Set());
    const groups = rows.filter((r): r is ContainerGroupRow => r.kind === 'group');
    const alpha = groups.find((g) => g.key === 'i-alpha')!;
    expect(alpha.count).toBe(2);
    expect(alpha.archivedCount).toBe(1);
    const bravo = groups.find((g) => g.key === 'i-bravo')!;
    expect(bravo.count).toBe(1);
    expect(bravo.archivedCount).toBe(0);
  });

  it('collapsed groups (default) hide their container rows', () => {
    const rows = groupContainers(all, new Set());
    expect(rows.every((r) => r.kind === 'group')).toBe(true);
    expect(rows.length).toBe(3);
  });

  it('expanded groups show their container rows right after the header, in order', () => {
    const rows = groupContainers(all, new Set(['i-alpha']));
    const alphaIdx = rows.findIndex((r) => r.kind === 'group' && r.key === 'i-alpha');
    const itemRows = rows.slice(alphaIdx + 1, alphaIdx + 3) as ContainerItemRow[];
    expect(itemRows.map((r) => r.item.id)).toEqual(['a1', 'a2']);
    // the next group's header follows immediately, no stray container rows
    expect(rows[alphaIdx + 3]).toMatchObject({ kind: 'group', key: 'i-bravo' });
  });

  it('a group header always appears even when collapsed, so counts stay visible', () => {
    const rows = groupContainers(all, new Set());
    const none1 = rows.find((r) => r.kind === 'group' && r.key === NO_INITIATIVE_KEY) as ContainerGroupRow;
    expect(none1.count).toBe(1);
    expect(none1.expanded).toBe(false);
  });
});

describe('containerGroupKeys / containerGroupKey', () => {
  it('lists every group key for Expand all, independent of expansion state', () => {
    const rows: ContainerItem[] = [
      { ...row, id: 'a1', initiative_id: 'i-alpha', initiative_name: 'Alpha' },
      { ...row, id: 'n1', initiative_id: null, initiative_name: null },
    ];
    expect(containerGroupKeys(rows)).toEqual(['i-alpha', NO_INITIATIVE_KEY]);
  });

  it('maps a container to the same key groupContainers would use for it', () => {
    expect(containerGroupKey({ initiative_id: 'i-alpha' })).toBe('i-alpha');
    expect(containerGroupKey({ initiative_id: null })).toBe(NO_INITIATIVE_KEY);
  });
});
