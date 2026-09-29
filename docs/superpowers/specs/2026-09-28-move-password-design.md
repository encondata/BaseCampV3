# Move passwords for kiosk sign-in — design

**Date:** 2026-09-28 · **Branch:** `move-password`

## Goal

An admin sets a password on a move (initiative). A kiosk can sign in with that password alone, as long as the move is still active, and that kiosk session can only set the kiosk up for that one move.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Who sets it | Admin rank and above (rank ≥ 60), from the initiative's edit modal. |
| Rules | Moves only. Surrounding whitespace is trimmed first; then at least 8 characters, never containing the move's name (case-insensitive), unique across all initiatives. |
| Storage | Encrypted (reversible) so admins can reveal it; a keyed fingerprint enforces uniqueness and drives the login lookup. |
| Who the session is | Each move with a password gets a hidden kiosk identity ("Kiosk · <move name>"): a person with source `kiosk_move`, an account with no password, the `worker` role. The move password signs the kiosk in as that identity, so scans, punches and audit rows carry "Kiosk · <move>". |
| When it works | Only while the move is not completed, cancelled (the statuses the kiosk already treats as historical), a status keyed `historical` if one is ever added, or archived. |
| Scope | The session is tagged with the move; Kiosk Setup offers only that move and the server refuses any other, and every kiosk route that names a move, asset, container or truck refuses another move (see "Move lock" below). Clearing or rotating the password, or the move becoming inactive, ends its kiosk sessions. |

## Data (migration `0083_move_passwords`, `down_revision = "0082"`)

- `initiatives.kiosk_password_enc TEXT NULL` — Fernet-encrypted password (same key as the 2FA secrets, `SS_TOTP_ENCRYPTION_KEY`, through a shared `security/secretbox.py` that `services/totp.py` also uses).
- `initiatives.kiosk_password_fp TEXT NULL` with a unique index — `hmac.new(pepper, b"move-password\0" + password, sha256)` hex, keyed with `SS_PASSWORD_PEPPER` and domain-separated by the `move-password\0` prefix so it is never comparable with any other HMAC made from the pepper. Unique index = uniqueness across moves; lookup at sign-in.
- `initiatives.kiosk_person_id UUID NULL REFERENCES people(id)` — the move's kiosk identity, created on the first set.
- `auth_sessions.initiative_id UUID NULL REFERENCES initiatives(id)` — set on move-password sessions only, with the partial index `ix_auth_sessions_initiative` (`WHERE initiative_id IS NOT NULL`) that `revoke_move_sessions` uses.

## API

`services/move_password.py`:
- `MOVE_LOGIN_BLOCKED_STATUSES = HISTORICAL_INITIATIVE_STATUSES + ("historical",)` (i.e. `completed`, `cancelled`, `historical`).
- `fingerprint(password) -> str`; `set_password(db, initiative, password, *, actor_id)`; `clear_password(db, initiative, *, actor_id)`; `reveal(initiative) -> str | None`; `find_initiative_by_password(db, password) -> Initiative | None`; `ensure_kiosk_identity(db, initiative) -> UserAccount` (person `first_name="Kiosk"`, `last_name=<initiative name>`, `source="kiosk_move"`, `source_ref=str(initiative.id)`; account `email=f"kiosk+{initiative.id}@kiosk.serversherpa.local"`, `password_hash=None`; `PersonRole worker`); `revoke_move_sessions(db, initiative_id)` (revoke reason `admin`; revokes every live session locked to the move and, belt and braces, every live session of the move's kiosk identity even without `initiative_id`); `is_move_active(initiative) -> bool`.
- `find_initiative_by_password` matches moves only: a password left on an initiative whose type changed away from `move` signs nothing in.
- Renaming an initiative renames its kiosk identity's last name.

`PATCH /initiatives/{id}` (`InitiativeUpdateIn.kiosk_password: str | None`, absent = unchanged):
- Present and not admin rank → 403 `kiosk_password_forbidden`.
- `null` or `""` → clear (also revokes the move's kiosk sessions).
- The value is trimmed of surrounding whitespace, and the rules apply to the trimmed value (which is what is stored): initiative not a move → 422 `kiosk_password_moves_only`; shorter than 8 → 422 `kiosk_password_too_short`; contains the move's name, case-insensitively → 422 `kiosk_password_contains_name`; fingerprint already on another initiative → 422 `kiosk_password_in_use` (also when the unique index catches a race at flush or commit).
- Re-saving the password the move already has is a no-op: no rotation (kiosks stay signed in) and no audit row. A different password is a rotation and revokes the move's kiosk sessions.
- Audit row `changes={"kiosk_password": {"from": "set"|null, "to": "set"|null}}` — never the value.
- `InitiativeDetailOut.kiosk_password_set: bool`.
- A status change into a blocked status, and `POST /{id}/archive`, revoke the move's kiosk sessions.

`GET /initiatives/{id}/kiosk-password` (admin rank; 403 otherwise) → `{"password": str | null}`, audited as `kiosk_password.reveal`, sent with `Cache-Control: no-store`.

`POST /kiosk/move-login` (unauthenticated; the same per-IP rate limit `/kiosk/pair` and `/auth/login` use): body `{password}`.
- No match → 401 `invalid_move_password` (after a dummy fingerprint compare so timing is flat).
- Match but inactive/archived → 401 `move_not_active`.
- Otherwise `ensure_kiosk_identity`, `start_session(client="kiosk", audit_action="login_move", initiative_id=…)`, and the usual kiosk session response with `kiosk_move: {"initiative_id", "name"}`.

Session payloads (`SessionOut`, `MeOut`): `kiosk_move: {initiative_id, name} | null`, from `session.initiative_id`.

Kiosk endpoints: `GET /kiosk/setup-options` returns only the session's move when the session has one (empty if it has since become inactive); `POST /kiosk/setup` with a different `initiative_id` → 403 `move_locked`.

### Move lock

A move-password session (`session.initiative_id` set) may act only on its own move; person-login kiosk sessions (`initiative_id` null) are unaffected. `routes/kiosk.py::_require_move(actor, initiative_id)` raises 403 `move_locked` when the id is not the session's move (a missing id counts as another move):
- `GET /kiosk/sync/assets|containers|trucks` — the `initiative_id` query parameter.
- `POST /kiosk/scans` — each scan's move (its own `initiative_id`, else the kiosk's setup). A scan on another move is rejected on its own with code `move_locked` in `rejected`, like the other per-row codes, and the rest of the batch still lands (the batch shape already supports per-row rejection, and a whole-batch 403 would wedge the kiosk's outbox behind one stale row).
- `POST /kiosk/timeclock/clock-in` — the resolved move (body, else the kiosk's setup). `POST /kiosk/timeclock/clock-out` — the open entry's move, when it has one (a shift opened with no move, such as a portal self-service punch, can still be closed).
- `POST /kiosk/assets/{id}/rfid` — the resolved move, and the asset must be on the move's roster (`initiative_assets`).
- `POST /kiosk/containers/{id}/assets` — the resolved move, the container's `initiative_id`, and the asset on the roster.
- `POST /kiosk/trucks/{id}/containers` — the resolved move, the truck's and the container's `initiative_id`.
- `GET /kiosk/sync/people` and the timeclock status read stay unrestricted: workers not assigned to the move still clock in at its kiosks.

Pairing: `POST /kiosk/pair/{code}/approve` and `/deny` refuse a move-password session (403 `move_locked`) — an approval would hand the move's hidden identity to another kiosk without the lock. `POST /kiosk/pair/{code}/poll` treats an approval whose approver is a kiosk identity (`source == "kiosk_move"`) as denied (status `denied`, audit `kiosk_pair_claim_denied` with `reason: "kiosk_identity"`), so no unlocked identity session is ever minted.

Hidden identity: people with `source == "kiosk_move"` are excluded from `GET /users`, `GET /workers`, the kiosk people sync and search. They never get a password, so `/auth/login` refuses them.

## Kiosk

- `moveLoginRequest(password)` → `POST /kiosk/move-login`; `KioskAuthContext.loginWithMovePassword`; `State.kioskMove`.
- Login page: the Move password form calls it; an empty field says "Enter the move password." without calling the API; errors "That move password isn't right." / "That move password isn't active." / (`kiosk_not_allowed`) "That move can't sign in to kiosks right now. Ask a coordinator."; the placeholder notice goes away.
- A move sign-in (or a cookie restore of one) whose saved setup (`ss.kiosk.setup`) names a different move clears it and sets the setup state back to `incomplete`, so `SetupGate` sends the crew to Kiosk Setup and the footer shows the session's move.
- Footer: `Move: <name>` from the session when the kiosk isn't set up yet (setup's value wins once set).
- Kiosk Setup: unchanged code; the server returns one move.

## Portal

- `InitiativeFields` (edit mode, admin only, moves only): **Kiosk password** — a masked input with Show, a **Generate** button that fills it with 12 random characters from `A-Z a-z 2-9` without the look-alikes `0 O 1 l I` (`crypto.getRandomValues`, rejection-sampled) and shows it unmasked, hint "At least 8 characters, unique across moves, and not the move's name. Crews sign in to the kiosk with it.", a **Reveal current** link (calls the reveal endpoint, shows it inline) when one is set, and a **Clear** checkbox. `initiativePayload` sends `kiosk_password` only when the user typed one or ticked Clear (`""`).
- Errors: `kiosk_password_too_short` → "Kiosk password must be at least 8 characters."; `kiosk_password_in_use` → "That kiosk password is already used by another move."; `kiosk_password_contains_name` → "The kiosk password can't contain the move's name."; `kiosk_password_moves_only` → "Only moves have a kiosk password."
- Initiative detail: admins see "Kiosk password: set / not set" on moves.

## Testing

API `tests/test_move_password_api.py`: set (creates identity, hidden from /users, /workers, kiosk sync, search), too short, duplicate across moves, non-admin 403, clear revokes sessions, reveal (admin only, audited), login accept, wrong → 401, inactive statuses and archived → 401, session locked to the move (setup-options one entry, setup other → 403), status change to completed / archive revoke, `/auth/login` with the identity's email refused, rename follows, trim + name rule + moves only, same-password re-save keeps sessions, reveal `no-store`, commit-time clash → 422. `tests/test_move_password_lock.py`: move session can't approve/deny a pairing, identity-approved pairing polls `denied`, revoke catches an unlocked identity session, every locked route 403 for another move and 200 for its own, person-login kiosk sessions reach both. Portal: field visibility by rank, payload only when changed, error copy, detail line. Kiosk: login form success path, the errors, the empty field, footer shows the move, a mismatched saved setup is cleared on move sign-in. Full suites; migration head single.

## Out of scope

- Rotating passwords automatically; expiry.
- Restricting the people sync to the move's crew (workers not on the move still clock in).
