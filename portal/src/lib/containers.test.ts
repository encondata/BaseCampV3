import { describe, expect, it } from 'vitest';

import type { ContainerItem } from './api';
import {
  containerCellText, containerPayload, containerSearchText, formFromContainer,
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
