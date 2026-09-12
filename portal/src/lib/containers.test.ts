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
