import { describe, expect, it } from 'vitest';
import { applyWorkerPatch, WORKER_ERRORS, WORKER_GOD_FIELDS, type WorkerItem } from './workers';
import type { StatusValue } from './api';

const worker: WorkerItem = {
  person_id: 'p1', display_name: 'Jamie Rivera', first_name: 'Jamie', last_name: 'Rivera',
  contact_email: 'jamie@example.com', phone: null, avatar_url: null, has_account: true,
  trade: 'Server tech', level: 'L2', status: 'active', status_label: 'Active',
  status_color: '#178a4c', status_note: null,
  partner: { id: 'pt1', name: 'Acme Staffing' },
  cert_count: 3, certs_expired: 0,
};

const statuses: StatusValue[] = [
  { record_type: 'worker', key: 'active', label: 'Active', description: '',
    color: '#178a4c', sort_order: 1, is_active: true, usage_count: 5 },
  { record_type: 'worker', key: 'bench', label: 'On the bench', description: '',
    color: '#c9840e', sort_order: 2, is_active: true, usage_count: 1 },
];

// Fields upsert_profile (PUT /workers/{id}/profile, api/src/serversherpa/api/
// routes/workers.py) accepts via WorkerProfileIn (api/src/serversherpa/api/
// schemas.py:526-537): trade, level, partner_id, status, status_note — the
// full set the endpoint will `setattr` from `body.model_dump(exclude_unset=True)`.
// Verified 1:1 against the handler; WORKER_GOD_FIELDS must only ever name a
// field from this set.
const WORKER_WRITABLE_FIELDS = new Set(['trade', 'level', 'partner_id', 'status', 'status_note']);

describe('WORKER_GOD_FIELDS', () => {
  const fields = WORKER_GOD_FIELDS({
    levels: () => [{ value: 'L2', label: 'L2 · Journeyman' }],
    statuses: () => [{ value: 'active', label: 'Active' }],
  });

  it('only exposes fields the profile PATCH endpoint accepts', () => {
    for (const f of fields) expect(WORKER_WRITABLE_FIELDS.has(f.field)).toBe(true);
  });

  it('every fromRow round-trips a sample row', () => {
    const expected: Record<string, string> = { trade: 'Server tech', level: 'L2', status: 'active' };
    expect(fields.map((f) => f.column).sort()).toEqual(Object.keys(expected).sort());
    for (const f of fields) expect(f.fromRow(worker)).toBe(expected[f.column]);
  });

  it('trade/level fall back to empty string when unset', () => {
    const bare = { ...worker, trade: null, level: null };
    const trade = fields.find((f) => f.column === 'trade')!;
    const level = fields.find((f) => f.column === 'level')!;
    expect(trade.fromRow(bare)).toBe('');
    expect(level.fromRow(bare)).toBe('');
  });

  it('deliberately has no descriptor for the name, partner, or rollup columns', () => {
    for (const col of ['primary', 'partner', 'certs', 'contact']) {
      expect(fields.some((f) => f.column === col)).toBe(false);
    }
  });
});

describe('applyWorkerPatch', () => {
  it('merges a simple field (trade) with no denormalisation needed', () => {
    const updated = applyWorkerPatch(worker, { trade: 'Electrician' }, statuses);
    expect(updated.trade).toBe('Electrician');
    expect(updated.status_label).toBe('Active'); // unrelated fields untouched
  });

  it('merges level with no lookup — LevelBadge resolves it at render time', () => {
    const updated = applyWorkerPatch(worker, { level: 'L3' }, statuses);
    expect(updated.level).toBe('L3');
  });

  it('re-denormalises status_label/status_color when status changes', () => {
    const updated = applyWorkerPatch(worker, { status: 'bench' }, statuses);
    expect(updated.status).toBe('bench');
    expect(updated.status_label).toBe('On the bench');
    expect(updated.status_color).toBe('#c9840e');
  });

  it('leaves label/colour alone if the new status key is not in the lookup', () => {
    const updated = applyWorkerPatch(worker, { status: 'retired-unknown' }, statuses);
    expect(updated.status).toBe('retired-unknown');
    expect(updated.status_label).toBe('Active');
  });

  it('never mutates the input row', () => {
    const before = { ...worker };
    applyWorkerPatch(worker, { trade: 'Electrician' }, statuses);
    expect(worker).toEqual(before);
  });
});

describe('WORKER_ERRORS', () => {
  it('covers every code upsert_profile can raise, plus the generic 403', () => {
    for (const code of [
      'person_not_found', 'not_a_worker', 'status_required', 'blacklist_requires_note',
      'rank_too_low', 'cannot_target_self', 'unknown_level', 'partner_not_found',
      'unknown_status', 'forbidden',
    ]) {
      expect(WORKER_ERRORS[code]).toBeTruthy();
    }
  });
});
