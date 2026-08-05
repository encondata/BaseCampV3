import { describe, expect, it } from 'vitest';
import {
  needsStatusCreate, parseSortOrder, recordTypeOptions, siteTypeFormFromValue,
  siteTypeUpdatePayload, statusCreatePayload, statusFormFromValue,
  statusSearchText, statusUpdatePayload, workerLevelFormFromValue,
  workerLevelUpdatePayload,
} from './variables';
import type { SiteLookup, StatusValue, WorkerLevel } from './api';

const value: StatusValue = {
  record_type: 'site', key: 'planned', label: 'Planned',
  description: 'Not yet in service.', color: 'c-aqua',
  sort_order: 2, is_active: true, usage_count: 3,
};

const siteType: SiteLookup = {
  key: 'datacenter', label: 'Data centre',
  description: 'Colocation or owned data centre space.',
  sort_order: 1, icon: 'server', color: null,
};

const workerLevel: WorkerLevel = {
  level: 'L3', rank: 3, title: 'Technician II',
  description: 'Works unsupervised.',
  expected_skills: ['Cabling', 'Racking'],
};

describe('statusSearchText', () => {
  it('covers key, label, description and record type', () => {
    const text = statusSearchText(value);
    expect(text).toContain('planned');
    expect(text).toContain('not yet in service');
    expect(text).toContain('site');
  });

  it('is lowercased so callers can compare directly', () => {
    expect(statusSearchText(value)).toBe(statusSearchText(value).toLowerCase());
  });
});

describe('recordTypeOptions', () => {
  it('lists each record type once, sorted', () => {
    const worker = { ...value, record_type: 'worker', key: 'standby' };
    expect(recordTypeOptions([value, worker, { ...value, key: 'active' }]))
      .toEqual([
        { value: 'site', label: 'site' },
        { value: 'worker', label: 'worker' },
      ]);
  });

  it('is empty for no values', () => {
    expect(recordTypeOptions([])).toEqual([]);
  });
});

describe('statusUpdatePayload', () => {
  it('sends only what changed', () => {
    const form = { ...statusFormFromValue(value), label: 'Scheduled' };
    expect(statusUpdatePayload(form, value)).toEqual({ label: 'Scheduled' });
  });

  it('sends is_active false rather than dropping it', () => {
    const form = { ...statusFormFromValue(value), is_active: false };
    expect(statusUpdatePayload(form, value)).toEqual({ is_active: false });
  });

  it('is empty when nothing changed', () => {
    expect(statusUpdatePayload(statusFormFromValue(value), value)).toEqual({});
  });

  it('coerces sort_order to a number', () => {
    const form = { ...statusFormFromValue(value), sort_order: '7' };
    expect(statusUpdatePayload(form, value)).toEqual({ sort_order: 7 });
  });

  it('sends sort_order 0 rather than dropping it', () => {
    // 0 is a legitimate sort_order. A truthiness check on the coerced value
    // would silently drop it — this test is what fails if that ever happens.
    const form = { ...statusFormFromValue(value), sort_order: '0' };
    expect(statusUpdatePayload(form, value)).toEqual({ sort_order: 0 });
  });
});

describe('statusCreatePayload', () => {
  it('carries every required field', () => {
    const form = {
      record_type: 'site', key: 'mothballed', label: 'Mothballed',
      description: '', color: 'c-violet', sort_order: '5', is_active: true,
    };
    expect(statusCreatePayload(form)).toEqual({
      record_type: 'site', key: 'mothballed', label: 'Mothballed',
      description: '', color: 'c-violet', sort_order: 5,
    });
  });
});

describe('needsStatusCreate', () => {
  it('creates when editing nothing and nothing was created yet', () => {
    expect(needsStatusCreate(null, null)).toBe(true);
  });

  it('does not re-create after a successful create', () => {
    expect(needsStatusCreate(null, 'mothballed')).toBe(false);
  });

  it('never creates when editing an existing value', () => {
    expect(needsStatusCreate(value, null)).toBe(false);
  });
});

describe('parseSortOrder', () => {
  it('parses a valid non-negative integer', () => {
    expect(parseSortOrder('7')).toBe(7);
  });

  it('accepts 0 — a legitimate sort order, not "empty"', () => {
    expect(parseSortOrder('0')).toBe(0);
  });

  it('rejects an empty field rather than coercing it to 0', () => {
    // Number('') is 0 — a silent, wrong default. A cleared field must be
    // refused by the caller, not quietly saved as sort_order 0.
    expect(parseSortOrder('')).toBeNull();
  });

  it('rejects whitespace-only input', () => {
    expect(parseSortOrder('   ')).toBeNull();
  });

  it('rejects non-numeric input rather than sending NaN', () => {
    // Number('abc') is NaN, which JSON-stringifies to null and 422s on this
    // non-nullable field.
    expect(parseSortOrder('abc')).toBeNull();
  });

  it('rejects a negative number', () => {
    expect(parseSortOrder('-1')).toBeNull();
  });

  it('rejects a non-integer', () => {
    expect(parseSortOrder('1.5')).toBeNull();
  });

  it('tolerates surrounding whitespace on an otherwise valid value', () => {
    expect(parseSortOrder(' 4 ')).toBe(4);
  });
});

describe('siteTypeUpdatePayload', () => {
  it('sends only what changed', () => {
    const form = { ...siteTypeFormFromValue(siteType), label: 'DC' };
    expect(siteTypeUpdatePayload(form, siteType)).toEqual({ label: 'DC' });
  });

  it('is empty when nothing changed', () => {
    expect(siteTypeUpdatePayload(siteTypeFormFromValue(siteType), siteType)).toEqual({});
  });

  it('sends an explicit null to clear the icon', () => {
    // site_types.icon is nullable — NULL is how "no icon" is spelled. Sending
    // '' would put a semantically wrong empty string in a nullable column.
    // The server must not drop this null (routes/sites.py update_site_type).
    const form = { ...siteTypeFormFromValue(siteType), icon: '' };
    expect(siteTypeUpdatePayload(form, siteType)).toEqual({ icon: null });
  });

  it('treats a whitespace-only icon as cleared', () => {
    const form = { ...siteTypeFormFromValue(siteType), icon: '   ' };
    expect(siteTypeUpdatePayload(form, siteType)).toEqual({ icon: null });
  });

  it('does not re-send an icon that was already null', () => {
    const noIcon = { ...siteType, icon: null };
    expect(siteTypeUpdatePayload(siteTypeFormFromValue(noIcon), noIcon)).toEqual({});
  });

  it('sends sort_order 0 rather than dropping it', () => {
    const form = { ...siteTypeFormFromValue(siteType), sort_order: '0' };
    expect(siteTypeUpdatePayload(form, siteType)).toEqual({ sort_order: 0 });
  });
});

describe('workerLevelUpdatePayload', () => {
  it('sends only what changed', () => {
    const form = { ...workerLevelFormFromValue(workerLevel), title: 'Tech III' };
    expect(workerLevelUpdatePayload(form, workerLevel)).toEqual({ title: 'Tech III' });
  });

  it('is empty when nothing changed', () => {
    expect(workerLevelUpdatePayload(workerLevelFormFromValue(workerLevel), workerLevel))
      .toEqual({});
  });

  it('never sends level or rank — the API forbids unknown fields', () => {
    const form = { ...workerLevelFormFromValue(workerLevel), title: 'X' };
    const out = workerLevelUpdatePayload(form, workerLevel);
    expect(out).not.toHaveProperty('level');
    expect(out).not.toHaveProperty('rank');
  });

  it('sends expected_skills when a skill is added', () => {
    const form = {
      ...workerLevelFormFromValue(workerLevel),
      expected_skills: ['Cabling', 'Racking', 'Splicing'],
    };
    expect(workerLevelUpdatePayload(form, workerLevel))
      .toEqual({ expected_skills: ['Cabling', 'Racking', 'Splicing'] });
  });

  it('sends an emptied skill list rather than dropping it', () => {
    const form = { ...workerLevelFormFromValue(workerLevel), expected_skills: [] };
    expect(workerLevelUpdatePayload(form, workerLevel)).toEqual({ expected_skills: [] });
  });

  it('detects a reorder — order is meaningful to the reader', () => {
    const form = {
      ...workerLevelFormFromValue(workerLevel),
      expected_skills: ['Racking', 'Cabling'],
    };
    expect(workerLevelUpdatePayload(form, workerLevel))
      .toEqual({ expected_skills: ['Racking', 'Cabling'] });
  });
});
