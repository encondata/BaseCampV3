import { describe, expect, it } from 'vitest';

import { ApiError, type ImportJobResults } from './api';
import { formFromInitiative } from './initiatives';
import {
  assetSummary, cratesBody, createdCount, initialCrates, missingMoveFields, MOVE_SETUP_ERRORS,
  MOVE_SETUP_STEPS, moveSetupError, movePayload, setupReasons,
} from './moveSetup';

const form = () => ({ ...formFromInitiative(null), initiative_type: 'move' });

it('has five steps in order', () => {
  expect(MOVE_SETUP_STEPS.map((s) => s.title)).toEqual(
    ['The move', 'From-To assets', 'Crates', 'Trucks', 'Review and create']);
});

it('always posts a move', () => {
  expect(movePayload({ ...form(), initiative_type: 'project', name: ' A ' })).toMatchObject(
    { initiative_type: 'move', name: 'A' });
});

it('names what the move is missing as one sentence', () => {
  expect(missingMoveFields(form())).toBe(
    'The move needs a name, an origin site, and a destination site.');
  expect(missingMoveFields({ ...form(), name: 'A', origin_site_id: 's1' })).toBe(
    'The move needs a destination site.');
  expect(missingMoveFields({ ...form(), name: 'A', origin_site_id: 's1', destination_site_id: 's2' })).toBeNull();
});

it('prefills crates from the site codes and builds the request body', () => {
  const value = initialCrates({ code: 'SJC' } as never, { code: 'DAL' } as never);
  expect(value).toEqual({ convention: 'CRT-SJC-DAL-xxx', count: '0', start: '1', container_type: '', tags: {} });
  expect(cratesBody({ ...value, count: '3', container_type: 'pallet', tags: { priority: 1 } })).toEqual({
    convention: 'CRT-SJC-DAL-xxx', count: 3, start: 1, container_type: 'pallet',
    tags: { priority: 1, vendor: 0, accessories: 0, warehouse: 0, ewaste: 0 },
  });
});

describe('errors', () => {
  it('covers every code the routes and the worker return', () => {
    for (const code of ['draft_not_found', 'draft_not_editable', 'setup_invalid', 'name_taken',
      'apply_conflict', 'worker_error', 'forbidden', 'origin_required', 'destination_required',
      'no_asset_file', 'bad_container_type', 'bad_tag_key', 'tags_exceed_count']) {
      expect(MOVE_SETUP_ERRORS[code], code).toMatch(/\.$/);
    }
  });
  it('prefers the naming sentence, then the maps', () => {
    expect(moveSetupError(new ApiError(422, 'invalid_naming', { code: 'invalid_naming', message: "Use only one run of x's for the number." })))
      .toBe("Use only one run of x's for the number.");
    expect(moveSetupError(new ApiError(422, 'site_not_found'))).toBe('Pick a site from the list.');
    expect(moveSetupError(new ApiError(422, 'unsupported_file'))).toMatch(/csv/);
    // the wizard locks the type, so its own sentence wins over "Pick a type from the list."
    expect(moveSetupError(new ApiError(422, 'unknown_initiative_type')))
      .toBe("Moves can't be created because the Move type is missing.");
    expect(setupReasons(new ApiError(422, 'setup_invalid', { code: 'setup_invalid', reasons: ['Pick a crate type.'] })))
      .toEqual(['Pick a crate type.']);
  });
});

it('turns the import details into the per-row summary', () => {
  const results: ImportJobResults = { summary: {}, details: [
    { row: 2, serial_number: 'sn-1', status: 'created', message: 'Asset added to move', asset_id: 'a1' },
    { row: 3, serial_number: 'sn-2', status: 'review', message: "Make/Model 'X' not found — needs review" },
  ] };
  const out = assetSummary(results);
  expect([out.created, out.updated, out.skipped, out.unchanged]).toEqual([1, 0, 1, 0]);
  expect(out.rows[1]).toMatchObject({ row: 3, name: 'sn-2', action: 'skipped', asset_id: null });
  expect(createdCount(1, 'crate')).toBe('1 crate created');
  expect(createdCount(3, 'truck')).toBe('3 trucks created');
});
