# Demote a user to a worker — design

**Date:** 2026-09-28 · **Branch:** `demote-user`

## Goal

When someone quits, an admin can turn their portal user into a plain worker record in one action: the login and every kind of portal access go away, but the person stays in People with their badge, RFID, time entries, scans and assignments intact, so they can still be clocked in as a worker and can be given a login again later.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| The login | Removed entirely (the `user_accounts` row is deleted). The person shows as **No account**, like a contact who never had one; "Create account" brings them back. |
| Badge and RFID | Kept. They remain a potential worker. |
| Where | The user detail page header and the Users list row menu, next to Disable account. |
| Safety | Same rules as Disable: `users:change`, global actors only, not yourself, only people you outrank. One transaction, one audit row. |

## Server: `POST /users/{person_id}/demote` (204)

In `api/src/serversherpa/api/routes/users.py`, next to `disable_account`. Uses `_load_target` (which already enforces global actor, not-self, existence of an account, and rank) and then, in one transaction:

1. `_revoke_all_sessions(db, person_id, "demoted")`.
2. `totp_service.reset(db, account, actor_id=…, ip=…)` — clears the 2FA secret, backup codes and trusted browsers (writes its own `totp.reset` audit row, as it does for Reset 2FA).
3. Revoke every active `PersonRole` (global and org-anchored alike): `revoked_at = now`, `revoked_by = actor`. The roles are recorded in the audit row.
4. Delete every `AccessGroupMember` and `NotificationGroupMember` row for the person. Group names are recorded in the audit row.
5. Delete the `UserAccount` row (`password_history` cascades).
6. `audit(action="account.demote", entity_type="user_account", changes={"roles": [...], "access_groups": [...], "notification_groups": [...], "login_email": email})`.
7. Commit.

Errors: `404 user_not_found` when the person has no account (from `_load_target`); `403 cannot_target_self` / `403 forbidden` / `403 rank_too_low` as the other admin actions.

Untouched: `people` row fields (including `badge_uid`, `rfid_tag`, `archived_at`), time entries, scans, initiative assignments, notes, audit history. Kiosk badge/RFID clock-ins keep working.

After the call the person no longer appears in `GET /users` (that list is people with logins) and `GET /users/{id}` returns 404 `user_not_found`; they remain in the People/Workers directory and can be promoted again with `POST /users/{id}/account`.

## Portal

`portal/src/lib/api.ts`: `demoteUser(personId)` → `POST /users/{id}/demote`.

**Confirmation modal** (`DemoteUserModal` in `portal/src/components/UserAdminModals.tsx`, same header pattern as `AccountStateModal`):
- Eyebrow "Users", title "Demote to worker".
- Body: "Demote {name} to a worker? Their portal login, roles, access groups, notification groups, two-factor setup and remembered browsers are removed, and they're signed out everywhere. Their badge, RFID and history stay; they leave this Users list but remain under People, and can be given a login again later."
- Buttons: Cancel, **Demote** (danger). Errors map through the existing `errText`.
- On success calls `onDone()`; callers reload.

**User detail page** (`portal/src/pages/UserDetail.tsx`): a **Demote to worker** button (`mini-btn danger`) in the Profile tab's manage actions, after Disable/Enable account, shown when the person has an account and the actor can manage users. Opens the modal; on done, navigate to `/people/users` (the detail page no longer resolves for a person without a login).

**Users list** (`portal/src/pages/Users.tsx`): a **Demote to worker** row action (destructive) after Disable/Enable, gated by `users:change` and the rank check, (every row in this list has a login). On done, refresh the list; the row disappears.

American English throughout.

## Testing

**API** (`api/tests/test_account_mgmt.py`, alongside the disable tests):
- Full cleanup: a worker with roles, an access group, a notification group, an enrolled 2FA secret, a trusted device and a live session is demoted → 204; their session token is rejected; login returns `invalid_credentials`; no active roles; no group memberships; no `TrustedDevice` active rows; `user_accounts` row gone; `password_history` rows gone; `people` row unchanged including `badge_uid` and `rfid_tag`; the person is absent from `GET /users` and `GET /users/{id}` is 404; one `account.demote` audit row listing the removed roles and groups.
- Refusals: self → 403 `cannot_target_self`; a person with no account → 404; a higher-ranked target → 403.
- Re-promotion: after demoting, `POST /users/{id}/account` succeeds.

**Portal** (Vitest): `UserDetail.test.tsx` — the button appears for a manageable user with an account, not for an outranked one or one without an account; confirming posts and navigates to `/people/users`. `Users.test.tsx` — the row menu lists "Demote to worker" for a manageable row and not for self or an outranked row; confirming posts and reloads the list. `UserAdminModals` — the modal shows the name and calls the API on Demote.

**Final checks:** the full API suite, the portal suite, `tsc`, build.

## Out of scope

- Archiving the person.
- Removing badge/RFID (kept on purpose).
- Bulk demotion.
