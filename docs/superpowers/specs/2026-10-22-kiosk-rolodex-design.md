# Kiosk Rolodex: design

Date: 2026-10-22. Status: approved by Jimmy in conversation ("looks right, write it up and build it"; "no more questions"). Mockups: `docs/superpowers/specs/2026-10-22-kiosk-rolodex-mockups/` (open the `.html` files in a browser; `2-list-chosen.html`, `3-new-worker.html` and `4-photo-required-and-worker-page.html` are the decided screens, `1-options-and-flows.html` shows the rejected face-grid option too). Code maps from the recon: `.superpowers/rolodex-recon/{api,android,ios}.md` in the `kiosk-rolodex` worktree (git-ignored; exact files, lines, helpers and commands).

## 1. Intent

Admins on a job site need to look up crew members, fix their details and photograph new people on the spot, from the kiosk phone or tablet they already carry. Today that takes the portal. The Rolodex brings it to the native kiosk apps: a contact list of every worker with their photo, a worker page to edit details and retake the photo, and a New worker flow where the admin types the details and photographs the worker.

Success: an admin on an iPad or Android tablet opens Rolodex from Home, finds a worker by last name in seconds, takes a new photo with the back camera, and adds a new crew member with a photo, who then shows up at the Time Clock.

## 2. Decisions Jimmy made

- **Platforms:** the iOS app (`IOS_Kiosk_App/`) and the Android app (`Android_Kiosk_App/`), on phones and tablets. Not the web/laptop kiosk.
- **Who:** signed-in users with admin rank or higher (rank 60+: admin, super admin, founder, developer). Staff, workers and move-password sign-ins never see it.
- **List style:** an A–Z list like the phone's Contacts app (option B), **sorted and sectioned by last name**, with a letter jump strip. Each row: photo (or gray initials), name, job title · company, status chip. Search by name, job title or company; filters All, Active, Standby, Blacklist (plus No photo, see §4.3).
- **Tablet:** list on the left, the selected worker's page on the right. **Phone:** the worker page opens full screen.
- **Who holds the device:** the admin holds the tablet and photographs the worker, so the **camera opens on the back camera** (Flip available).
- **Photo is required for a new worker**, with an override: no Skip button, a quiet "Continue without photo" link that opens a confirmation ("Create Marcus Reed without a photo?" — default Take photo, other choice Create without photo).
- **Worker page:** photo with a camera badge (tap → Take new photo / Choose photo; no Remove, since photos are required), name, job title · company, status chip, RFID enrolled chip. Edit: first*, last*, preferred name, job title, phone, email, company, trade, level, status (Active / Standby / Blacklist; Blacklist needs a note and can't be applied to yourself). Employee ID and RFID tag are read-only. Address, certifications and notes stay in the portal.
- **New worker:** details step, then the photo step, then "Position your photo" (drag, pinch or slide to zoom), then Create. Duplicate-name warning before creating. Creates a worker with **no portal login**, who appears at the Time Clock.
- **Offline:** shows the last list it loaded, read-only; saving needs a connection.

## 3. My calls (Jimmy said "no more questions"; each is mine and reversible)

1. **Home tile only on the full kiosk Home.** Station Homes (Time Clock, Label, RFID stations) keep exactly the tiles Jimmy chose for them. The Rolodex tile needs no move or setup step (always available once signed in as admin).
2. **Gate = rank ≥ 60 and a global role.** The server checks `kiosk:view`, rank ≥ 60 (`GATE_BYPASS_RANK`), `access.is_global` (same as `require_bulk_rank`), and per action `workers:view` / `workers:add` / `workers:change` (+ `attachments:add` for photos). Person sessions only: station keys and move-locked sessions are refused. The apps show the tile when `isAdmin` (rank ≥ 60); a 403 from the server shows "Your account can't use the Rolodex."
3. **List contents:** every non-archived worker the admin can see in the portal (same query and scope filter as `GET /workers`), excluding the hidden move identity (`source = 'kiosk_move'`). Sorted by last name, then first name (natural order). Rows show `preferred_name or first_name` + last name.
4. **No email or phone in the list or the offline cache** (the existing `/kiosk/sync/people` privacy rule); they load with the worker page.
5. **Photo upload is a raw `image/jpeg` PUT, not multipart.** Neither app has multipart code, and a raw body lets the auth checks run before the body is read. The apps always send the 512×512 JPEG they rendered.
6. **Photo-required rule lives in the apps.** The create call carries `photo_skipped: true` only after the confirmation, and the server records it in the audit row. The worker is created first, then the photo uploads; if the upload fails, the worker page opens with "Marcus Reed was saved, but the photo didn't upload." and a Try again button.
7. **Duplicates:** a separate `POST /kiosk/rolodex/duplicates` (names in the body, never in a URL) returns matching people. The app calls it when leaving the details step; matches show a "Possible duplicate" sheet with Open (go to that person) or Create anyway. The create route also refuses with 409 `possible_duplicate` unless `allow_duplicate: true`, so a race is caught. A match is any non-archived person (worker or not, excluding the hidden move identity) whose `first last` or `preferred last` name matches (case- and whitespace-insensitive, the bulk import's `name_keys`), or whose email matches, or whose normalized phone matches.
8. **Status on create** defaults to Active and isn't shown in the New worker form (it can be changed on the worker page).
9. **Company picker** offers non-archived partners plus "None"; a worker whose current company has since been archived still shows it.
10. **Split view breakpoint:** Android at ≥ 600dp window width, iOS at a regular horizontal size class with ≥ 700pt width. The list pane is 340–380 wide.
11. **Devices without a camera** (the Zebra MC2200, the iOS simulator): the photo step and the photo sheet offer Choose photo only. On a new worker the "Continue without photo" link still works.
12. **Camera permission denied:** show "Camera access is off. Turn it on in Settings, or choose a photo instead." with Choose photo.
13. **After a create or edit,** the app updates its local people table (the Time Clock's offline roster) so the Time Clock finds the worker right away, and refreshes the Rolodex list.
14. **Audit:** generic actions (`person/create`, `person/update`, `worker/profile.update`, `person/attachment.add`) so the portal's activity views render them as usual, with `"via": "kiosk_rolodex"` and `"device": <kiosk serial>` in the changes.
15. **Offline banner:** "Offline · showing the list from 3:42 PM. Changes need a connection." Edit, New and photo actions are disabled while offline. The cached list is cleared on sign-out, session end and Reset app.
16. **Duplicate matches that aren't workers** (staff, portal users, client contacts): the sheet shows them as "Already in the portal, not a worker. Add the worker role there." with no Open button; the kiosk never grants roles to existing people. Worker matches get Open. **An email match blocks Create anyway** ("That email belongs to <name>. Change or clear the email."), since the email can't be reused; name or phone matches allow Create anyway.
17. **Photos follow the edit rule:** the photo route applies the same `can_touch_rank` check as edits (403 `rank_too_low` for a target with a portal login ranked at or above yours, unless it's yourself), and the camera badge is disabled when `can_edit` is false.
18. **Statuses come from the server:** the status control and the status filter chips are built from `/options` (statuses can be customized in the portal); with the seeded values they read Active, Standby, Blacklist. The chip row is All, one chip per active status, then No photo.
19. **Level** starts empty on a new worker (the mockup's "L1" is a placeholder). Trade is free text, as in the portal.
20. **Local roster upsert** after a create or edit keeps the person's existing `rfid_tag` and `badge_uid` (the detail payload carries `rfid_enrolled` and `external_id`, not the tag itself).
21. **Mockup text vs this document:** where `2-list-chosen.html` says "my guess: by first name", this document's "by last name" wins.


## 4. What gets built

### 4.1 API (`api/`)

New module `api/src/serversherpa/api/routes/kiosk_rolodex.py`, `APIRouter(prefix="/kiosk/rolodex", tags=["kiosk"])`, registered in `api/app.py` after `kiosk.router`. Kiosk sessions already reach `/kiosk/*` (`deps.enforce_session_scope`); read-only mode (423) and forced password change (403) apply automatically. No migration (head stays 0105).

Every route: `require_permission("kiosk", "view")` + `require_rank(GATE_BYPASS_RANK)` + `is_global` (403 `forbidden`), refuse move-locked sessions (`session.initiative_id` set → 403 `move_locked`), plus the per-route permission below. Any person that is missing, archived, the hidden move identity, or not an active worker → 404 `person_not_found`.

| Route | Extra gate | Body → Response |
|---|---|---|
| `GET /kiosk/rolodex/workers` | `workers:view` | → `{generated_at, workers: [row]}` |
| `GET /kiosk/rolodex/workers/{person_id}` | `workers:view` | → detail |
| `GET /kiosk/rolodex/options` | `workers:view` | → `{levels: [{level, title, color}], statuses: [{key, label, color}], partners: [{id, name}]}` (active statuses; non-archived partners, natural order) |
| `POST /kiosk/rolodex/duplicates` | `workers:add` | `{first_name, last_name, preferred_name?, email?, phone?}` → `{matches: [{person_id, display_name, job_title, company, is_worker, has_account, photo_url, photo_version, matched_on: ["name"|"email"|"phone"]}]}` |
| `POST /kiosk/rolodex/workers` | `workers:add` | create body → 201 detail; 409 `possible_duplicate` unless `allow_duplicate`; 409 `email_in_use` |
| `PATCH /kiosk/rolodex/workers/{person_id}` | `workers:change` | patch body → detail (person and profile changes in **one transaction**) |
| `PUT /kiosk/rolodex/workers/{person_id}/photo` | `workers:change` + `attachments:add` + `can_touch_rank` on account holders (§3.17) | raw `image/jpeg` body → `{photo_url, photo_version}` |

- **List row:** person_id, first_name, last_name, preferred_name, display_name, job_title, company `{id, name} | null`, trade, level, level_color, status, status_label, status_color, has_photo, photo_url (presigned, 600 s), photo_version, rfid_enrolled, has_account. No email or phone.
- **Detail:** the row plus email, phone, external_id (Employee ID), status_note, `can_edit` (false when the target has a portal login the actor can't touch: `can_touch_rank`), `can_change_status` (false for yourself or an untouchable target), and `edit_block_reason` (`rank_too_low` / `self` / null).
- **Create body** (`extra="forbid"`, names stripped, `min_length=1`): first_name*, last_name*, preferred_name, job_title, phone, email (EmailStr), partner_id, trade, level, allow_duplicate (bool), photo_skipped (bool). Writes `Person(source="manual", source_ref="kiosk-rolodex:<serial or 'unknown'>", created_by)`, a `PersonRole(role="worker")` and a `WorkerProfile(status="active", …)` in one transaction (model: `people/bulk_import._create_worker`). Validation as the profile route: unknown level 422 `unknown_level`, unknown partner 422 `partner_not_found`, archived partner on a new link 422 `partner_archived`. Email pre-check → 409 `email_in_use` (keep the IntegrityError fallback).
- **Patch body** (`extra="forbid"`, `exclude_unset`; explicit null clears a nullable field; null on first/last → 422 `{field}_required`): first_name, last_name, preferred_name, job_title, phone, email, partner_id, trade, level, status, status_note. Same rules as the portal's `PATCH /workers/{id}/person` and `PUT /workers/{id}/profile`: `rank_too_low`, `cannot_target_self`, `blacklist_requires_note`, `unknown_level`, `partner_not_found`, `unknown_status`, `email_in_use`; blacklisting an account holder disables the login and ends their sessions.
- **Photo:** require Content-Length (411 `length_required`), cap 5 MiB (413 `file_too_large`), stream with a running cap, empty 422 `empty_file`, JPEG only by sniffing (422 `invalid_file_type`), Pillow probe in a thread (`labels/image_prep.probe`: 422 `unreadable_image` / `image_too_large`). Store at `attachments/person/{id}/avatar/{uuid4}.jpg`, retire the old avatar rows, repoint `person.avatar_key`, add the Attachment row (`filename="kiosk-photo.jpg"`), audit; on a failed DB write roll back and delete the new object (the branding-logo pattern).
- **photo_version** = first 16 hex of `sha256(avatar_key)` (the key changes on every upload), null without a photo. Apps cache photo bytes by `person_id + photo_version`, never by URL.
- **Shared code, low churn:** extract the inline logic of `workers.py` `update_worker_person` and `upsert_profile` into `api/src/serversherpa/api/worker_edits.py` (`target_rank`, `apply_person_update`, `apply_profile_update`, no commits); the portal routes call them and keep their behavior and tests. Extract the avatar-replace block of `attachments.py` into a helper both routes use.

### 4.2 Both apps: shared behavior

- **Home:** a "Rolodex" tile (icon: a card file / contact card in the existing line-icon style) shown only when signed in with rank ≥ 60, on the full kiosk Home. A direct route to the Rolodex for a non-admin bounces Home.
- **List:** A–Z by last name (then first), letter sections (`#` for names not starting with A–Z), a right-edge jump strip, a search field (every typed word must prefix-match a word of the name, preferred name, job title or company; case- and accent-insensitive), filter chips with counts: All, Active, Standby, Blacklist, No photo. Header: eyebrow "Rolodex", title "N workers", a "+ New" button. Rows: 44pt avatar (photo, else gray initials gradient `#334155→#64748B` like the Time Clock), name, "job title · company", status chip in the status color. Pull to refresh (phone) / a refresh action.
- **Worker page:** as in the mockups. Edit switches the cards to fields with Save changes / Cancel; Save sends only changed fields (cleared → null). Status is a segmented control; choosing Blacklist reveals a required note field. When `can_edit` is false the Edit button is disabled with the reason ("This person has a portal login ranked above yours."); when `can_change_status` is false the status control is disabled ("You can't change your own status.").
- **Photo sheet:** Take new photo (back camera) / Choose photo / Cancel. Camera screen: live preview, circle guide, "Frame the worker's face in the circle", shutter, Flip, Library. Then "Position your photo": circular mask, drag to pan, pinch and a slider to zoom 1×–4× over cover-fit, the image always covers the circle, "Drag to move · pinch or slide to zoom", Retake / Use photo. Output: 512×512 JPEG, quality 0.92, painted white first, EXIF orientation applied. Upload, then refresh the worker and its list row.
- **New worker:** "+ New" → "New worker · Step 1 of 2 · Details" (first*, last*, preferred, job title, phone, email, company, trade, level) → "Next: photo" runs the duplicate check (sheet "Possible duplicate": the matches with photo, name, job title, company; Open / Create anyway) → photo step ("Continue without photo" link → confirmation) → Position your photo → Create worker. Then the worker page opens and the list refreshes.
- **Errors (American English):** 403 forbidden "Your account can't use the Rolodex."; 423 "The system is in read-only mode, so changes can't be saved right now."; 409 email_in_use "Another person already uses that email."; 403 rank_too_low "This person has a portal login ranked above yours."; 403 cannot_target_self "You can't change your own status."; 422 blacklist_requires_note "Add a note to blacklist someone."; photo 413/422 "That photo couldn't be used. Take or choose another one."; network "No connection. Try again when you're back online."; anything else "Something went wrong. Try again."
- **Offline:** §3.15.

### 4.3 Android specifics

Follow `.superpowers/rolodex-recon/android.md` ("Suggested Android file plan"). Key points: `FeatureId.ROLODEX` kept out of `FEATURES` (parity tests), `homeFeatures(stationType, isAdmin)`; an `AdminGate` guard; `KioskShell(scroll = false)` for the list (a LazyColumn can't sit inside the shell's verticalScroll); CameraX `ImageCapture` + `PickVisualMedia`; `ImageDecoder` for EXIF; crop math in Android-free `core`; reuse the Time Clock `loadPhoto()` fetch (never copy it); a small `LruCache` keyed by person id + photo_version; the offline list in the Room `meta` table (key `rolodex`, no migration); writes under `NonCancellable`; `FakeKioskApi` gets every new call. Don't bump `coreKtx`, `lifecycle` or `activityCompose`.

### 4.4 iOS specifics

Follow `.superpowers/rolodex-recon/ios.md` (§0 table and §7 gotchas). Key points: `FeatureId.rolodex` + a `ROLODEX_FEATURE` constant kept out of `FEATURES`, and `feature(_:)` must find it; `Route.rolodex` (+ a phone worker route with its own "‹ Rolodex" back); a new `PhotoCamera` (AVCapturePhotoOutput) separate from the barcode scanner; `.photosPicker` for the library; pure crop math in `Core/` and a UIKit renderer (`scale = 1`, opaque, white); a hand-written `encode(to:)` so PATCH sends `null`; raw-body upload through the authed helper; the offline list in a `MetaRecord` (`rolodex`); unique file basenames; reword `NSCameraUsageDescription` in Debug and Release to "The camera scans barcodes and takes worker photos." `FakeKioskApi` gets every new call.

## 5. Out of scope

Web and laptop kiosks; portal changes; archiving or deleting workers; creating portal logins; editing Employee ID, RFID tag, address, certifications or notes; removing a photo; badge printing; Play Store / TestFlight uploads (Jimmy decides those separately).

## 6. Risks accepted

- Kiosk password sign-ins skip two-factor (existing behavior), so a rank-60 kiosk session can now edit people's details and blacklist workers. Mitigated by the rank-60 + global-role gate, refusing move-password sessions, `can_touch_rank` on account holders, and audit rows that name the kiosk.
- The portal's `PATCH /workers/{id}/person` / `PUT /workers/{id}/profile` don't exclude the hidden move identity (pre-existing; the Rolodex routes do). Recorded as a follow-up, not fixed here.

## 7. Acceptance

- API tests for every route, gate, persona (admin 60 allowed; staff 40, worker 10, move session, station key refused), read-only 423, create → appears in `/kiosk/sync/people`, duplicates, patch rules in one transaction, photo storage/replace/cleanup; the portal worker and attachment tests stay green after the refactor.
- Android unit + Robolectric tests (sorting/sections/search/filters, crop math, view model incl. offline and NonCancellable writes, API client incl. raw upload, Home tile gating, admin guard, phone vs tablet layout); `assembleDebug` green.
- iOS unit tests (same logic set) green on the iPad and iPhone simulators; Debug and Release builds green.
- Live check on the dev stack: Android tablet emulator and iOS iPad simulator, signed in as an admin: list, search, split view, edit and save, new worker via Library photo, duplicate warning, photo-required confirmation; a staff sign-in sees no tile.
