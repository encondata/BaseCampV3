import { describe, expect, it } from 'vitest';
import { applyUserPatch, USER_ERRORS, USER_GOD_FIELDS, type UserItem } from './users';
import type { PersonDetail } from './api';

const user: UserItem = {
  person_id: 'p1', first_name: 'Jamie', last_name: 'Rivera', preferred_name: null,
  display_name: 'Jamie Rivera', job_title: 'Ops Manager', phone: '555-0100',
  contact_email: 'jamie@example.com', login_email: 'jamie@login.example.com',
  roles: ['staff'], status: 'active', must_change_password: false,
  last_login_at: '2026-08-01T00:00:00Z', account_created_at: '2026-01-01T00:00:00Z',
  archived_at: null, avatar_url: null, max_rank: 10,
};

const detail: PersonDetail = {
  id: 'p1', first_name: 'Jamie', last_name: 'Rivera', preferred_name: null,
  display_name: 'Jamie Rivera', email: 'jamie@example.com', phone: '555-0199',
  job_title: 'Senior Ops Manager', address_line1: null, address_line2: null,
  city: null, region: null, postal_code: null, country: 'US',
  badge_uid: 'b1', created_at: '2026-01-01T00:00:00Z', avatar_key: null,
  avatar_url: null, password_updated_at: null,
};

// Fields admin_update_profile (PATCH /users/{person_id}/profile, api/src/
// serversherpa/api/routes/users.py) accepts via ProfileUpdateIn (api/src/
// serversherpa/api/schemas.py:199-216): first_name, last_name,
// preferred_name, email, phone, job_title, address_line1, address_line2,
// city, region, postal_code, country — the full set the endpoint will
// `setattr` from `body.model_dump(exclude_unset=True)`. Verified 1:1
// against the schema; USER_GOD_FIELDS must only ever name a field from
// this set.
const PROFILE_WRITABLE_FIELDS = new Set([
  'first_name', 'last_name', 'preferred_name', 'email', 'phone', 'job_title',
  'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country',
]);

describe('USER_GOD_FIELDS', () => {
  const fields = USER_GOD_FIELDS();

  it('only exposes fields the profile PATCH endpoint accepts', () => {
    for (const f of fields) expect(PROFILE_WRITABLE_FIELDS.has(f.field)).toBe(true);
  });

  it('every fromRow round-trips a sample row', () => {
    const expected: Record<string, string> = { job_title: 'Ops Manager', phone: '555-0100' };
    expect(fields.map((f) => f.column).sort()).toEqual(Object.keys(expected).sort());
    for (const f of fields) expect(f.fromRow(user)).toBe(expected[f.column]);
  });

  it('job_title/phone fall back to empty string when unset', () => {
    const bare = { ...user, job_title: null, phone: null };
    const jobTitle = fields.find((f) => f.column === 'job_title')!;
    const phone = fields.find((f) => f.column === 'phone')!;
    expect(jobTitle.fromRow(bare)).toBe('');
    expect(phone.fromRow(bare)).toBe('');
  });

  it('deliberately has no descriptor for the guarded or computed columns', () => {
    for (const col of [
      'roles', 'status', 'contact_email', 'last_login', 'created', 'primary',
    ]) {
      expect(fields.some((f) => f.column === col)).toBe(false);
    }
  });
});

describe('applyUserPatch', () => {
  it('merges job_title and phone from the server response', () => {
    const updated = applyUserPatch(user, detail);
    expect(updated.job_title).toBe('Senior Ops Manager');
    expect(updated.phone).toBe('555-0199');
  });

  it('leaves unrelated fields untouched', () => {
    const updated = applyUserPatch(user, detail);
    expect(updated.roles).toEqual(['staff']);
    expect(updated.status).toBe('active');
    expect(updated.login_email).toBe('jamie@login.example.com');
  });

  it('never mutates the input row', () => {
    const before = { ...user };
    applyUserPatch(user, detail);
    expect(user).toEqual(before);
  });
});

describe('USER_ERRORS', () => {
  it('covers every code admin_update_profile can raise, plus the generic 403', () => {
    for (const code of [
      'user_not_found', 'cannot_target_self', 'rank_too_low', 'forbidden', 'email_in_use',
    ]) {
      expect(USER_ERRORS[code]).toBeTruthy();
    }
  });
});
