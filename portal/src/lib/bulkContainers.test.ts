/**
 * lib/bulkContainers.ts — naming/tag-assignment math for
 * `BulkContainersModal`. Pure, no jsdom needed.
 */
import { describe, expect, it } from 'vitest';

import {
  assignTags, buildNames, clampTags, previewNames, summaryText, tagTotal, TAG_ASSIGNMENT_ORDER,
  type NamingConfig,
  autoPad, numberOverflow,
} from './bulkContainers';

const naming = (over: Partial<NamingConfig> = {}): NamingConfig =>
  ({ prefix: 'PLT-', start: 1, pad: 3, suffix: '', ...over });

describe('buildNames', () => {
  it('builds prefix + zero-padded(start + i) + suffix for each of count', () => {
    expect(buildNames(naming(), 3)).toEqual(['PLT-001', 'PLT-002', 'PLT-003']);
  });

  it('honors a non-1 start number', () => {
    expect(buildNames(naming({ start: 10 }), 3)).toEqual(['PLT-010', 'PLT-011', 'PLT-012']);
  });

  it('pad 0 means no padding at all', () => {
    expect(buildNames(naming({ pad: 0 }), 3)).toEqual(['PLT-1', 'PLT-2', 'PLT-3']);
  });

  it('pads to the requested width regardless of value', () => {
    expect(buildNames(naming({ pad: 4, start: 9 }), 2)).toEqual(['PLT-0009', 'PLT-0010']);
  });

  it('applies a suffix after the padded number', () => {
    expect(buildNames(naming({ suffix: '-A' }), 2)).toEqual(['PLT-001-A', 'PLT-002-A']);
  });

  it('an empty prefix and suffix still produce non-empty names (the number itself)', () => {
    expect(buildNames(naming({ prefix: '', suffix: '' }), 2)).toEqual(['001', '002']);
  });

  it('count 0 produces an empty array', () => {
    expect(buildNames(naming(), 0)).toEqual([]);
  });
});

describe('previewNames', () => {
  it('four or fewer names: the full list, comma-joined', () => {
    expect(previewNames(naming(), 3)).toBe('PLT-001, PLT-002, PLT-003');
    expect(previewNames(naming(), 4)).toBe('PLT-001, PLT-002, PLT-003, PLT-004');
  });

  it('more than four: first three, an ellipsis, then the last', () => {
    expect(previewNames(naming(), 15)).toBe('PLT-001, PLT-002, PLT-003 … PLT-015');
  });

  it('count 0 is an empty string', () => {
    expect(previewNames(naming(), 0)).toBe('');
  });
});

describe('TAG_ASSIGNMENT_ORDER', () => {
  it('is Priority, Vendor, Accessories, Warehouse, E-Waste — Jimmy\'s stated order', () => {
    expect(TAG_ASSIGNMENT_ORDER).toEqual(['priority', 'vendor', 'accessories', 'warehouse', 'ewaste']);
  });
});

describe('assignTags', () => {
  it('assigns the first N in order, one tag key per container, then null for the rest', () => {
    expect(assignTags(5, { priority: 1, vendor: 2 })).toEqual([
      'priority', 'vendor', 'vendor', null, null,
    ]);
  });

  it('walks through every tag key in TAG_ASSIGNMENT_ORDER order', () => {
    expect(assignTags(5, { priority: 1, vendor: 1, accessories: 1, warehouse: 1, ewaste: 1 })).toEqual([
      'priority', 'vendor', 'accessories', 'warehouse', 'ewaste',
    ]);
  });

  it('no tags at all: every slot is null', () => {
    expect(assignTags(3, {})).toEqual([null, null, null]);
  });

  it('never overruns count even if the tag total is somehow larger', () => {
    expect(assignTags(2, { priority: 5 })).toEqual(['priority', 'priority']);
  });
});

describe('tagTotal', () => {
  it('sums every tag count', () => {
    expect(tagTotal({ priority: 1, vendor: 2, ewaste: 3 })).toBe(6);
  });
  it('treats missing tags as 0', () => {
    expect(tagTotal({})).toBe(0);
  });
});

describe('clampTags', () => {
  it('no-op when the total already fits', () => {
    const result = clampTags({ priority: 1, vendor: 2 }, 10);
    expect(result.tags).toEqual({ priority: 1, vendor: 2 });
    expect(result.trimmed).toEqual({});
  });

  it('trims from the LAST tag in assignment order backwards', () => {
    // total 5 (1 priority, 2 vendor, 2 ewaste), count drops to 3: trim ewaste
    // first (2), then — still over by 0 — nothing else needed.
    const result = clampTags({ priority: 1, vendor: 2, ewaste: 2 }, 3);
    expect(result.tags).toEqual({ priority: 1, vendor: 2, ewaste: 0 });
    expect(result.trimmed).toEqual({ ewaste: 2 });
  });

  it('trims across multiple tags, still walking backwards, until the total fits', () => {
    // total 6, count drops to 2: trim ewaste (1) and warehouse (1) fully,
    // then all 2 of accessories, leaving priority (1) + vendor (1) = 2.
    const result = clampTags(
      { priority: 1, vendor: 1, accessories: 2, warehouse: 1, ewaste: 1 }, 2);
    expect(tagTotal(result.tags)).toBe(2);
    expect(result.trimmed).toEqual({ ewaste: 1, warehouse: 1, accessories: 2 });
    expect(result.tags).toEqual({ priority: 1, vendor: 1, accessories: 0, warehouse: 0, ewaste: 0 });
  });
});

describe('summaryText', () => {
  it('containers + each non-zero tag (in order) + untagged remainder', () => {
    expect(summaryText(15, { priority: 1, vendor: 2 })).toBe(
      '15 containers · 1 Priority · 2 Vendor · 12 untagged');
  });

  it('singular "container" for count 1', () => {
    expect(summaryText(1, {})).toBe('1 container · 1 untagged');
  });

  it('no untagged segment when every container is tagged', () => {
    expect(summaryText(3, { priority: 3 })).toBe('3 containers · 3 Priority');
  });

  it('no tag segments at all when nothing is tagged', () => {
    expect(summaryText(4, {})).toBe('4 containers · 4 untagged');
  });
});

describe('autoPad / numberOverflow', () => {
  it('pads to the digits of the last number plus one leading zero, capped at 4', () => {
    expect(autoPad(1, 1)).toBe(2);       // 1 → "01"
    expect(autoPad(1, 9)).toBe(2);       // 9 → "09"
    expect(autoPad(1, 10)).toBe(3);      // 10 → "010"
    expect(autoPad(1, 120)).toBe(4);     // 120 → "0120"
    expect(autoPad(1, 500)).toBe(4);
    expect(autoPad(995, 20)).toBe(4);    // 1014 → cap, no leading zero left
  });
  it('flags batches whose last number exceeds 9999', () => {
    expect(numberOverflow(9998, 2)).toBe(false);
    expect(numberOverflow(9998, 3)).toBe(true);
    expect(numberOverflow(1, 500)).toBe(false);
  });
});
