import { describe, expect, it } from 'vitest';
import {
  needsSiteTypeCreate, needsStatusCreate, needsWorkerLevelCreate, parseSortOrder,
  recordTypeOptions, siteTypeCreatePayload, siteTypeFormFromValue,
  siteTypeUpdatePayload, statusCreatePayload, statusFormFromValue,
  statusSearchText, statusUpdatePayload, workerLevelCreatePayload,
  workerLevelFormFromValue, workerLevelUpdatePayload,
} from './variables';
import type { SiteLookup, StatusValue, WorkerLevel } from './api';

const value: StatusValue = {
  record_type: 'site', key: 'planned', label: 'Planned',
  description: 'Not yet in service.', color: '#0f7c86',
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
  color: '#35e0c8',
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
      description: '', color: '#6d4fc4', sort_order: '5', is_active: true,
    };
    expect(statusCreatePayload(form)).toEqual({
      record_type: 'site', key: 'mothballed', label: 'Mothballed',
      description: '', color: '#6d4fc4', sort_order: 5,
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

  it('sends colour when it changed', () => {
    const form = { ...siteTypeFormFromValue(siteType), color: '#c03540' };
    expect(siteTypeUpdatePayload(form, siteType)).toEqual({ color: '#c03540' });
  });

  it('treats an untouched legacy-null colour as unchanged, not a silent assignment', () => {
    // siteType.color is null (a row that predates the hex migration).
    // siteTypeFormFromValue seeds the form with the same fallback this
    // function diffs against, so an untouched field must not show up as a
    // change just because null vs. a real hex look different.
    expect(siteTypeUpdatePayload(siteTypeFormFromValue(siteType), siteType)).toEqual({});
  });
});

describe('siteTypeCreatePayload', () => {
  it('carries every field, nulling an empty icon', () => {
    const form = {
      key: 'warehouse', label: 'Warehouse', description: 'Storage.',
      sort_order: '3', icon: '', color: '#1668a7',
    };
    expect(siteTypeCreatePayload(form)).toEqual({
      key: 'warehouse', label: 'Warehouse', description: 'Storage.',
      sort_order: 3, icon: null, color: '#1668a7',
    });
  });
});

describe('needsSiteTypeCreate', () => {
  it('creates when adding a new type and nothing was created yet', () => {
    expect(needsSiteTypeCreate(null, null)).toBe(true);
  });

  it('does not re-create after a successful create', () => {
    expect(needsSiteTypeCreate(null, 'warehouse')).toBe(false);
  });

  it('never creates when editing an existing type', () => {
    expect(needsSiteTypeCreate(siteType, null)).toBe(false);
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

  it('never sends level, rank or after — the API forbids unknown fields', () => {
    const form = { ...workerLevelFormFromValue(workerLevel), title: 'X' };
    const out = workerLevelUpdatePayload(form, workerLevel);
    expect(out).not.toHaveProperty('level');
    expect(out).not.toHaveProperty('rank');
    expect(out).not.toHaveProperty('after');
  });

  it('sends colour when it changed', () => {
    const form = { ...workerLevelFormFromValue(workerLevel), color: '#c03540' };
    expect(workerLevelUpdatePayload(form, workerLevel)).toEqual({ color: '#c03540' });
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

describe('workerLevelCreatePayload', () => {
  it('carries every field, including the insertion point', () => {
    const form = {
      level: 'L4', after: 'L3', title: 'Lead', description: 'Runs a crew.',
      expected_skills: ['Splicing'], color: '#6d4fc4',
    };
    expect(workerLevelCreatePayload(form)).toEqual({
      level: 'L4', title: 'Lead', description: 'Runs a crew.',
      expected_skills: ['Splicing'], color: '#6d4fc4', after: 'L3',
    });
  });

  it('sends after: null for the first position', () => {
    const form = {
      level: 'L0', after: null, title: 'Trainee', description: '',
      expected_skills: [], color: '#51606f',
    };
    expect(workerLevelCreatePayload(form)).toEqual({
      level: 'L0', title: 'Trainee', description: '',
      expected_skills: [], color: '#51606f', after: null,
    });
  });
});

describe('needsWorkerLevelCreate', () => {
  it('creates when adding a new level and nothing was created yet', () => {
    expect(needsWorkerLevelCreate(null, null)).toBe(true);
  });

  it('does not re-create after a successful create', () => {
    expect(needsWorkerLevelCreate(null, 'L4')).toBe(false);
  });

  it('never creates when editing an existing level', () => {
    expect(needsWorkerLevelCreate(workerLevel, null)).toBe(false);
  });
});

import {
  PRESET_COLORS, insertionPoints, isHex, normalizeHex, previewOrder, rankAfter,
} from './variables';

const LEVELS = [
  { level: 'L1', rank: 1, title: 'Apprentice', description: '', expected_skills: [], color: '#8a93a6' },
  { level: 'L2', rank: 2, title: 'Junior', description: '', expected_skills: [], color: '#4dd0ff' },
  { level: 'L3', rank: 3, title: 'Tech', description: '', expected_skills: [], color: '#35e0c8' },
];

describe('normalizeHex', () => {
  it('lowercases so equality and diffing are stable', () => {
    expect(normalizeHex('#AABBCC')).toBe('#aabbcc');
  });

  it('adds a missing leading hash — pasted brand colours often lack it', () => {
    expect(normalizeHex('aabbcc')).toBe('#aabbcc');
  });

  it('expands 3-digit shorthand', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeHex('  #AABBCC  ')).toBe('#aabbcc');
  });

  it('returns null for junk rather than guessing', () => {
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex('#gggggg')).toBeNull();
    expect(normalizeHex('')).toBeNull();
  });
});

describe('isHex', () => {
  it('accepts only the canonical stored form', () => {
    expect(isHex('#aabbcc')).toBe(true);
    expect(isHex('#AABBCC')).toBe(false);   // normalise first
    expect(isHex('c-green')).toBe(false);   // the old token format
  });
});

describe('PRESET_COLORS', () => {
  it('offers the seven the palette was built on, all canonical hex', () => {
    expect(PRESET_COLORS).toHaveLength(7);
    for (const p of PRESET_COLORS) expect(isHex(p.value)).toBe(true);
    expect(PRESET_COLORS.map((p) => p.label)).toContain('Green');
  });
});

describe('insertionPoints', () => {
  it('offers a gap before, between each pair, and after — last is default', () => {
    expect(insertionPoints(LEVELS)).toEqual([
      { after: null, label: 'Before L1 (first)' },
      { after: 'L1', label: 'Between L1 and L2' },
      { after: 'L2', label: 'Between L2 and L3' },
      { after: 'L3', label: 'After L3 (last)' },
    ]);
  });

  it('handles a single level — before and after, no between', () => {
    expect(insertionPoints([LEVELS[0]])).toEqual([
      { after: null, label: 'Before L1 (first)' },
      { after: 'L1', label: 'After L1 (last)' },
    ]);
  });

  it('offers one point for an empty scale', () => {
    expect(insertionPoints([])).toEqual([{ after: null, label: 'First level' }]);
  });

  it('sorts by rank regardless of input order', () => {
    // LEVELS above is already rank-ordered, so every test that only ever
    // passes it can't tell whether the `.sort()` in insertionPoints does
    // anything — deleting it would still pass. Feed it out of order instead.
    const shuffled = [LEVELS[2], LEVELS[0], LEVELS[1]];
    expect(insertionPoints(shuffled)).toEqual(insertionPoints(LEVELS));
  });
});

describe('rankAfter', () => {
  it('is the anchor rank plus one', () => {
    expect(rankAfter(LEVELS, 'L2')).toBe(3);
  });

  it('is 1 for the first position', () => {
    expect(rankAfter(LEVELS, null)).toBe(1);
  });

  it('is 1 for an empty scale', () => {
    expect(rankAfter([], null)).toBe(1);
  });

  it('is null for an anchor absent from levels — never guesses rank 1', () => {
    // A stale client list (the anchor was deleted between fetch and submit)
    // must not render a confident but false "inserts first" preview — the
    // server 422s unknown_level in this case (routes/workers.py::create_level).
    expect(rankAfter(LEVELS, 'L99')).toBeNull();
  });
});

describe('previewOrder', () => {
  it('inserts the new level at the chosen gap', () => {
    expect(previewOrder(LEVELS, 'L2B', 'L2')).toEqual(['L1', 'L2', 'L2B', 'L3']);
  });

  it('inserts at the front when after is null', () => {
    expect(previewOrder(LEVELS, 'L0', null)).toEqual(['L0', 'L1', 'L2', 'L3']);
  });

  it('inserts at the end after the last level', () => {
    expect(previewOrder(LEVELS, 'L4', 'L3')).toEqual(['L1', 'L2', 'L3', 'L4']);
  });

  it('is null for an unknown anchor — nothing rather than a false order', () => {
    expect(previewOrder(LEVELS, 'L7', 'L99')).toBeNull();
  });
});
