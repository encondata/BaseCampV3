# Rolodex Travel Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The kiosk Rolodex worker page (iOS and Android apps) shows and edits the worker profile's three travel fields, which the portal added on 2026-11-04 (main 545276dd, migration 0118).

**Architecture:** The API's Rolodex worker page (`GET/PATCH /kiosk/rolodex/workers/{id}`) carries the fields. Each app's detail model decodes them, its edit model and diff-only PATCH builder send them, and its worker page shows them in the Work card and edits them in the Edit form.

**Tech Stack:** FastAPI + pytest (api/), Kotlin + Compose + JUnit (Android_Kiosk_App/), Swift + SwiftUI + XCTest (IOS_Kiosk_App/).

**Spec:** none written. Jimmy skipped the questions ("add travel fields to the kiosk rolodex too", following "keep it simple" for the portal fields). The portal change is the reference: `api/migrations/versions/0118_worker_travel.py`, `portal/src/components/workers/ProfileForm.tsx`, `portal/src/components/workers/TravelRows.tsx`.

## Global Constraints

- **Field names (API JSON):** `will_travel` (boolean or null; null = not set, and false/No is a real answer distinct from null), `travel_region` (string or null), `travel_restrictions` (string or null).
- **Copy, exact:**
  - labels "Will travel", "Travel region", "Travel restrictions";
  - choices "Not set", "Yes", "No".
  - On the page, a not-set Will travel reads the way the page already shows an empty field. Region and restrictions show only when filled in.
- **Detail only:** the fields are on the worker page (detail), never on the list row. The list is cached offline, and restrictions can be personal.
- **New worker form:** unchanged. Travel is set from the worker page's Edit.
- **PATCH bodies stay diff-only:** an unchanged field is not sent, and a cleared text field is sent as an explicit `null`. Will travel is sent when it changes, including to null (Not set).
- **Copy rules:** American English. No placeholder or example text that invents content.
- **Compatibility:** an older API that sends none of the fields must still decode (missing = null).

## Review Focus

1. Will travel No (false) must round-trip as false, not collapse to null or not set. This applies to the decode, the edit model's seed, the PATCH builder and the display.
2. Changing only Will travel sends a body with only `will_travel`. Clearing the region sends `"travel_region": null`.
3. An older API response without the three keys still decodes, and the page shows them as empty.
4. An edit blocked by `can_edit == false` keeps the travel controls disabled like the other edit fields.
5. Long restriction text wraps on the page and in the form, and is not truncated.

---

### Task 1: API — Rolodex worker page carries the travel fields

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py`: `KioskRolodexWorkerDetailOut` and `KioskRolodexPatchIn`.
- Modify: `api/src/serversherpa/api/routes/kiosk_rolodex.py`: `PROFILE_FIELDS` and `worker_detail()`.
- Test: `api/tests/test_kiosk_rolodex_api.py`.

**Interfaces:**
- Produces:
  - `KioskRolodexWorkerDetailOut` gains `will_travel: bool | None = None`, `travel_region: str | None = None` and `travel_restrictions: str | None = None`. `KioskRolodexWorkerOut` (list row) does NOT.
  - `KioskRolodexPatchIn` gains `will_travel: bool | None = None`, `travel_region: RolodexText = None` and `travel_restrictions: RolodexText = None`. `RolodexText` turns blank into None, like `trade`.
  - The PATCH routes them through `apply_profile_update` (which already audits them via `api/worker_edits.py` `PROFILE_FIELDS`), with the Rolodex audit extras.

- [ ] **Step 1:** Write the failing test `test_patch_travel_fields_round_trip`. It covers three cases:
  - Detail on a fresh worker has all three null.
  - PATCH `{"will_travel": true, "travel_region": "Southeast US", "travel_restrictions": "No overnight flights"}` returns a detail with those values, and the audit row (`action='profile.update'`) has `changes["via"] == "kiosk_rolodex"` and `changes["will_travel"] == {"from": None, "to": True}`.
  - PATCH `{"will_travel": false, "travel_region": "  "}` returns `will_travel is False`, `travel_region is None` and the restrictions unchanged.
  - Assert the list endpoint rows have no `will_travel` key.
  - Follow the file's existing helpers for the admin session and worker setup.
- [ ] **Step 2:** Run it and see it fail. From `api/`: `SS_TEST_DB=serversherpa_test_rolodex_travel PYTHONPATH=src .venv/bin/python -m pytest tests/test_kiosk_rolodex_api.py -k travel -q`.
- [ ] **Step 3:** Implement the schema fields. Add the three names to `kiosk_rolodex.PROFILE_FIELDS`, and set them in `worker_detail()` from the profile (None when there is no profile).
- [ ] **Step 4:** Run the whole `tests/test_kiosk_rolodex_api.py`, `tests/test_workers.py` and `tests/test_worker_edits.py`. They must pass.
- [ ] **Step 5:** Commit: `feat(rolodex): the worker page carries Will travel, travel region and travel restrictions`.

### Task 2: Android — Rolodex worker page shows and edits travel

**Files** (all under `Android_Kiosk_App/app/src/`):
- Modify: `main/java/com/serversherpa/kiosk/core/model/Rolodex.kt`. Add `RolodexDetail` fields `will_travel: Boolean? = null`, `travel_region: String? = null` and `travel_restrictions: String? = null`.
- Modify: `main/java/com/serversherpa/kiosk/core/people/Rolodex.kt`.
  - Add `RolodexEdit` fields `willTravel: Boolean? = null`, `travelRegion: String = ""` and `travelRestrictions: String = ""`, seeded in `from()`.
  - `buildPatch`: put `will_travel` only when it changed (`JsonPrimitive(bool)` or `JsonNull`). The two text fields go through the existing `field()`.
- Modify: `main/java/com/serversherpa/kiosk/ui/screens/rolodex/WorkerPage.kt`.
  - **Work card:** after Trade · Level, add a "Will travel" Field (Yes / No, or the empty-field look when null), plus "Travel region" and "Travel restrictions" Fields, which show only when non-blank.
  - **EditForm:** after the Trade/Level row and before Status, add a "Will travel" control with Not set / Yes / No. Reuse the `Segmented` control the Status uses, with test tag `edit-travel`. Then a "Travel region" `TextBox` (tag `edit-travel-region`) and a multi-line "Travel restrictions" field (tag `edit-travel-restrictions`, sentence capitalization, like the Blacklist note). All are disabled while saving, like the other fields.
- Check: `main/java/com/serversherpa/kiosk/ui/screens/rolodex/RolodexViewModel.kt`. The `kept` logic near line 305 resets status when it can't be changed. Travel needs no special case. Confirm only.
- Test: `test/java/com/serversherpa/kiosk/core/people/RolodexTest.kt`. Add new cases:
  - `from()` seeds `willTravel=false` from a detail with `will_travel=false`.
  - Changing only willTravel builds `{"will_travel":false}`.
  - willTravel to null builds `{"will_travel":null}`.
  - Clearing the region builds `{"travel_region":null}`.
  - Unchanged travel builds `{}`.
- Test: `test/java/com/serversherpa/kiosk/data/api/OkHttpKioskApiRolodexTest.kt`. A detail JSON without the travel keys decodes to nulls, and one with `"will_travel": false` decodes false.

- [ ] **Step 1:** Write the failing unit tests above.
- [ ] **Step 2:** Run them and see them fail. From `Android_Kiosk_App/`: `./gradlew :app:testDebugUnitTest --tests '*RolodexTest*' --tests '*OkHttpKioskApiRolodexTest*'`.
- [ ] **Step 3:** Implement the model, edit, patch and UI changes.
- [ ] **Step 4:** Run `./gradlew :app:testDebugUnitTest` (the whole unit suite) and `./gradlew :app:assembleDebug`. Both must pass. If a Robolectric or Compose UI test of the worker page exists under `test/.../ui/screens/rolodex/`, add a case that the Edit form shows the three travel controls and that saving after picking Yes sends `will_travel: true`.
- [ ] **Step 5:** Commit: `feat(android): Rolodex worker page shows and edits travel`.

### Task 3: iOS — Rolodex worker page shows and edits travel

**Files** (all under `IOS_Kiosk_App/ServerSherpa Kiosk/`):
- Modify: `ServerSherpa Kiosk/Core/Rolodex/RolodexModels.swift`.
  - `RolodexDetail` gains `willTravel: Bool?`, `travelRegion: String?` and `travelRestrictions: String?`, decoded with `decodeIfPresent` (keys `will_travel`, `travel_region`, `travel_restrictions`), plus the memberwise init's defaults (nil).
  - `RolodexPatch` (near line 460) gains the three keys. Encoding must distinguish "not sent" from explicit null exactly as `status_note` does today.
- Modify: `ServerSherpa Kiosk/Core/Rolodex/RolodexLogic.swift`.
  - `RolodexEdit` gains `willTravel: Bool?`, `travelRegion = ""` and `travelRestrictions = ""`, seeded from the detail.
  - `buildPatch` sends `will_travel` only when it changed, null included. The text fields go through the existing changed/cleared mechanism.
- Modify: `ServerSherpa Kiosk/UI/Screens/Rolodex/RolodexWorkerView.swift`.
  - **Work section:** after trade/level, add `RolodexKeyValue` rows: "Will travel" (Yes / No, or the empty look when nil), plus "Travel region" and "Travel restrictions", which show only when non-blank.
  - **RolodexEditForm:** after Trade/Level and before Status, add a "Will travel" picker (Not set / Yes / No; a segmented `Picker` matching the form's existing style), a "Travel region" field, and a multi-line "Travel restrictions" field (`field(..., multiline: true)` like the Blacklist note).
- Test: `ServerSherpa KioskTests/RolodexLogicTests.swift` gets the same buildPatch cases as Android Task 2. `ServerSherpa KioskTests/RolodexModelTests.swift` gets the decode-missing-keys and decode-false cases, plus patch encoding (null vs absent).

- [ ] **Step 1:** Write the failing tests above.
- [ ] **Step 2:** Run them and see them fail. From `IOS_Kiosk_App/ServerSherpa Kiosk/`: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project "ServerSherpa Kiosk.xcodeproj" -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,name=<an installed iPad simulator>' -parallel-testing-enabled NO -only-testing:"ServerSherpa KioskTests/RolodexLogicTests" -only-testing:"ServerSherpa KioskTests/RolodexModelTests"`. List simulators with `xcrun simctl list devices available`.
- [ ] **Step 3:** Implement the models, logic and view changes.
- [ ] **Step 4:** Run the full unit test target (`-only-testing:"ServerSherpa KioskTests"`). It must pass. Never let tests touch the live API or Keychain: `RuntimeEnvironment.isUnitTestHost` already guards it.
- [ ] **Step 5:** Commit: `feat(ios): Rolodex worker page shows and edits travel`.
