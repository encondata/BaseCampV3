# Move passwords for kiosk sign-in — design

**Date:** 2026-09-28 · **Branch:** `move-password`

## Goal

An admin sets a password on a move (initiative). A kiosk can sign in with that password alone, as long as the move is still active, and that kiosk session can only set the kiosk up for that one move.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Who sets it | Admin rank and above (rank ≥ 60), from the initiative's edit modal. |
| Rules | At least 8 characters; unique across all initiatives. |
| Storage | Encrypted (reversible) so admins can reveal it; a keyed fingerprint enforces uniqueness and drives the login lookup. |
| Who the session is | Each move with a password gets a hidden kiosk identity ("Kiosk · <move name>"): a person with source `kiosk_move`, an account with no password, the `worker` role. The move password signs the kiosk in as that identity, so scans, punches and audit rows carry "Kiosk · <move>". |
| When it works | Only while the move is not completed, cancelled (the statuses the kiosk already treats as historical), a status keyed `historical` if one is ever added, or archived. |
| Scope | The session is tagged with the move; Kiosk Setup offers only that move and the server refuses any other. Clearing the password, or the move becoming inactive, ends its kiosk sessions. |

## Data (migration `0083_move_passwords`, `down_revision = "0082"`)

- `initiatives.kiosk_password_enc TEXT NULL` — Fernet-encrypted password (same key as the 2FA secrets, `SS_TOTP_ENCRYPTION_KEY`, through a shared `security/secretbox.py` that `services/totp.py` also uses).
- `initiatives.kiosk_password_fp TEXT NULL` with a unique index — `HMAC-SHA256(password, SS_PASSWORD_PEPPER)` hex. Unique index = uniqueness across moves; lookup at sign-in.
- `initiatives.kiosk_person_id UUID NULL REFERENCES people(id)` — the move's kiosk identity, created on the first set.
- `auth_sessions.initiative_id UUID NULL REFERENCES initiatives(id)` — set on move-password sessions only.

## API

`services/move_password.py`:
- `MOVE_LOGIN_BLOCKED_STATUSES = HISTORICAL_INITIATIVE_STATUSES + ("historical",)` (i.e. `completed`, `cancelled`, `historical`).
- `fingerprint(password) -> str`; `set_password(db, initiative, password, *, actor_id)`; `clear_password(db, initiative, *, actor_id)`; `reveal(initiative) -> str | None`; `find_initiative_by_password(db, password) -> Initiative | None`; `ensure_kiosk_identity(db, initiative) -> UserAccount` (person `first_name="Kiosk"`, `last_name=<initiative name>`, `source="kiosk_move"`, `source_ref=str(initiative.id)`; account `email=f"kiosk+{initiative.id}@kiosk.serversherpa.local"`, `password_hash=None`; `PersonRole worker`); `revoke_move_sessions(db, initiative_id)` (revoke reason `admin`); `is_move_active(initiative) -> bool`.
- Renaming an initiative renames its kiosk identity's last name.

`PATCH /initiatives/{id}` (`InitiativeUpdateIn.kiosk_password: str | None`, absent = unchanged):
- Present and not admin rank → 403 `kiosk_password_forbidden`.
- `null` or `""` → clear (also revokes the move's kiosk sessions).
- String shorter than 8 → 422 `kiosk_password_too_short`; fingerprint already on another initiative → 422 `kiosk_password_in_use`.
- Audit row `changes={"kiosk_password": {"from": "set"|null, "to": "set"|null}}` — never the value.
- `InitiativeDetailOut.kiosk_password_set: bool`.
- A status change into a blocked status, and `POST /{id}/archive`, revoke the move's kiosk sessions.

`GET /initiatives/{id}/kiosk-password` (admin rank; 403 otherwise) → `{"password": str | null}`, audited as `kiosk_password.reveal`.

`POST /kiosk/move-login` (unauthenticated; the same per-IP rate limit `/kiosk/pair` and `/auth/login` use): body `{password}`.
- No match → 401 `invalid_move_password` (after a dummy fingerprint compare so timing is flat).
- Match but inactive/archived → 401 `move_not_active`.
- Otherwise `ensure_kiosk_identity`, `start_session(client="kiosk", audit_action="login_move", initiative_id=…)`, and the usual kiosk session response with `kiosk_move: {"initiative_id", "name"}`.

Session payloads (`SessionOut`, `MeOut`): `kiosk_move: {initiative_id, name} | null`, from `session.initiative_id`.

Kiosk endpoints: `GET /kiosk/setup-options` returns only the session's move when the session has one (empty if it has since become inactive); `POST /kiosk/setup` with a different `initiative_id` → 403 `move_locked`. Everything else (heartbeat, sync, scans, timeclock, labels) works as for any kiosk session.

Hidden identity: people with `source == "kiosk_move"` are excluded from `GET /users`, `GET /workers`, the kiosk people sync and search. They never get a password, so `/auth/login` refuses them.

## Kiosk

- `moveLoginRequest(password)` → `POST /kiosk/move-login`; `KioskAuthContext.loginWithMovePassword`; `State.kioskMove`.
- Login page: the Move password form calls it; errors "That move password isn't right." / "That move password isn't active."; the placeholder notice goes away.
- Footer: `Move: <name>` from the session when the kiosk isn't set up yet (setup's value wins once set).
- Kiosk Setup: unchanged code; the server returns one move.

## Portal

- `InitiativeFields` (edit mode, admin only): **Kiosk password** — a masked input with Show, hint "At least 8 characters, unique across moves. Crews sign in to the kiosk with it.", a **Reveal current** link (calls the reveal endpoint, shows it inline) when one is set, and a **Clear** checkbox. `initiativePayload` sends `kiosk_password` only when the user typed one or ticked Clear (`""`).
- Errors: `kiosk_password_too_short` → "Kiosk password must be at least 8 characters."; `kiosk_password_in_use` → "That kiosk password is already used by another move."
- Initiative detail: admins see "Kiosk password: set / not set".

## Testing

API `tests/test_move_password_api.py`: set (creates identity, hidden from /users, /workers, kiosk sync, search), too short, duplicate across moves, non-admin 403, clear revokes sessions, reveal (admin only, audited), login accept, wrong → 401, inactive statuses and archived → 401, session locked to the move (setup-options one entry, setup other → 403), status change to completed / archive revoke, `/auth/login` with the identity's email refused, rename follows. Portal: field visibility by rank, payload only when changed, error copy, detail line. Kiosk: login form success path and both errors, footer shows the move. Full suites; migration head single.

## Out of scope

- Rotating passwords automatically; expiry.
- Restricting scanning/timeclock beyond setup (they already follow the kiosk's setup).
