import { describe, expect, it } from 'vitest';
import {
  applyUserPatch, ROLE_CLS, toManagedUser, toMemberItem, USER_ERRORS, USER_GOD_FIELDS,
  userCellText, userSearchText, type UserItem,
} from './users';
import type { PersonDetail, UserDetailOut } from './api';

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

describe('userCellText', () => {
  const blank: UserItem = {
    ...user, job_title: null, phone: null, contact_email: null, login_email: null,
    roles: [], status: 'invited', last_login_at: null, account_created_at: null,
  };

  it('primary combines display_name + login/contact email', () => {
    expect(userCellText(user, 'primary')).toBe('Jamie Rivera jamie@login.example.com');
    expect(userCellText({ ...user, login_email: null }, 'primary')).toBe('Jamie Rivera jamie@example.com');
    expect(userCellText({ ...user, login_email: null, contact_email: null }, 'primary')).toBe('Jamie Rivera');
  });

  it('roles joins the chip list, falling back to "no roles"', () => {
    expect(userCellText({ ...user, roles: ['staff', 'admin'] }, 'roles')).toBe('staff, admin');
    expect(userCellText(blank, 'roles')).toBe('no roles');
  });

  it('status reads the STATUS_META label, falling back to the bare key for an unknown status', () => {
    expect(userCellText(user, 'status')).toBe('Active');
    expect(userCellText(blank, 'status')).toBe('invited');
  });

  it('job_title/contact_email/phone dash when unset', () => {
    expect(userCellText(user, 'job_title')).toBe('Ops Manager');
    expect(userCellText(blank, 'job_title')).toBe('—');
    expect(userCellText(blank, 'contact_email')).toBe('—');
    expect(userCellText(blank, 'phone')).toBe('—');
  });

  it('last_login/created use the same formatters the cells render', () => {
    expect(userCellText(user, 'last_login')).not.toBe('');
    expect(userCellText(blank, 'last_login')).toBe('never');
    expect(userCellText(blank, 'created')).toBe('—');
  });

  it('must_change reads the tri-state as Yes/No', () => {
    expect(userCellText(user, 'must_change')).toBe('No');
    expect(userCellText({ ...user, must_change_password: true }, 'must_change')).toBe('Yes');
  });

  it('unknown column keys return empty string', () => {
    expect(userCellText(user, 'nonsense')).toBe('');
  });
});

describe('userSearchText', () => {
  it('includes name, emails, job title, phone, and roles', () => {
    const text = userSearchText(user);
    expect(text).toContain('jamie rivera');
    expect(text).toContain('jamie@login.example.com');
    expect(text).toContain('jamie@example.com');
    expect(text).toContain('ops manager');
    expect(text).toContain('555-0100');
    expect(text).toContain('staff');
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

const DETAIL: UserDetailOut = {
  person: {
    id: 'p1', first_name: 'Wan', last_name: 'Worker', preferred_name: null,
    display_name: 'Wan Worker', email: 'wan@x.test', phone: null, job_title: 'Tech',
    address_line1: null, address_line2: null, city: null, region: null, postal_code: null,
    country: 'US', badge_uid: 'B1', created_at: '2026-01-01T00:00:00Z', avatar_key: null,
    avatar_url: null, password_updated_at: null, source: 'manual', source_ref: null,
    archived_at: null,
  },
  account: { login_email: 'wan@x.test', status: 'active', must_change_password: false,
    last_login_at: null, created_at: '2026-01-01T00:00:00Z', password_updated_at: null },
  roles: [{ role: 'staff', label: 'Staff', rank: 40, scope_anchor: 'global', org: null,
    granted_by: null, granted_at: '2026-01-01T00:00:00Z' }],
  max_rank: 40, worker: null, notification_groups: [], access: null, sessions: null,
};

describe('user detail adapters', () => {
  it('ROLE_CLS maps the six roles', () => {
    expect(ROLE_CLS.admin).toBe('c-amber');
    expect(ROLE_CLS.worker).toBe('c-green');
  });
  it('toManagedUser flattens person + account + roles', () => {
    const m = toManagedUser(DETAIL);
    expect(m).toEqual({
      person_id: 'p1', display_name: 'Wan Worker', first_name: 'Wan', last_name: 'Worker',
      preferred_name: null, job_title: 'Tech', contact_email: 'wan@x.test', phone: null,
      roles: ['staff'], status: 'active', max_rank: 40, avatar_url: null,
    });
  });
  it('toMemberItem carries login email and roles', () => {
    expect(toMemberItem(DETAIL)).toEqual({
      person_id: 'p1', display_name: 'Wan Worker', job_title: 'Tech',
      login_email: 'wan@x.test', status: 'active', roles: ['staff'], max_rank: 40,
      avatar_url: null,
    });
  });
});
