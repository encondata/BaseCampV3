# Kiosk Biometric Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a device an admin has assigned to them, a person signs in to the Android kiosk app with a fingerprint or face. This works for 30 days after their last email-and-password sign-in. It is backed by an attested, biometric-gated Keystore key that the server registers and challenges.

**Architecture:**
- **API:** three schema additions (migration 0107), a key-attestation verifier, and a biometric service with kiosk routes: enroll-challenge, enroll, challenge, sign-in and forget. Admin routes cover the personal-device assignment and the key lists. Revocation is hooked into every existing session- and trust-revoke path.
- **Portal:** a Personal device row on the kiosk device page, plus "Biometric sign-in" panels on /me and the user page.
- **Android:** a Keystore/BiometricPrompt wrapper behind an interface, KioskAuth sign-in and enroll, and the login screen's "Sign in as …" card with Other account.

**Tech Stack:**
- API: FastAPI, SQLAlchemy async, Alembic, PyJWT, `cryptography`, `pyasn1` (new) for the KeyDescription extension.
- Portal: React + Vitest.
- Android: Kotlin, Jetpack Compose, `androidx.biometric:biometric:1.1.0` (new), Android Keystore.

**Spec:** `docs/superpowers/specs/2026-10-23-kiosk-biometric-sign-in-design.md`. Read the whole spec first; it is binding wherever this plan is silent.

Paths: API = `api/src/serversherpa`, APP = `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk`, APPT = the matching `src/test` tree.

## Global Constraints

### Platform and scope
- Android + API + portal only. No iOS code. Every API change is additive, so the iOS app keeps decoding.
- Migration `0107` chains on `0106`; Alembic heads stay single.
- Lines marked `// INTERNET-TEST` stay untouched (`RemovalGuardTest` counts).
- American English everywhere.
- Portal: reuse the dir-search, chip and pf-form idioms. Modals have rounded corners and the report-generate header.
- Android: reuse SettingsRow, SetupCard, MiniButton and the theme tokens. Check new layouts at 320 dp.

### Key and attestation
- Key: EC P-256 / `SHA256withECDSA` ("ES256").
  - `setUserAuthenticationRequired(true)`
  - `setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)`
  - `setInvalidatedByBiometricEnrollment(true)`
  - `setAttestationChallenge(nonce)`
  - StrongBox when available, else TEE.
- Attestation rules (spec §Attestation):
  - Google roots are pinned. The revocation list must be no more than 7 days old.
  - KeyDescription OID `1.3.6.1.4.1.11129.2.1.17`. The challenge equals the nonce.
  - Security level is TEE or StrongBox, for both attestation and keymint.
  - Hardware-enforced properties: EC, P-256, SIGN, `userAuthType` includes biometric, no `noAuthRequired`, no auth timeout.
  - Package `com.serversherpa.kiosk` with its digest in `SS_KIOSK_SIGNING_DIGESTS`.
  - Root of trust: `deviceLocked` and `verifiedBootState` Verified.

### Timing
- Biometric lifetime: 30 days from `password_sign_in_at`. Enroll window: a password session started ≤ 10 minutes ago.
- Challenge JWT `typ "bio"`, TTL 60 s. Enroll nonce JWT `typ "bioenroll"`, TTL 300 s.

### Session login methods
- `auth_sessions.login_method` ∈ `password` | `link` | `move` | `biometric`. It is set only server-side and carried through refresh rotation.
- `HeartbeatIn.login_method` and Android `LoginMethod` gain `biometric`.

### Error codes
| Code | Meaning |
|---|---|
| `no_biometric` | 404 |
| `biometric_expired` | 403 |
| `kiosk_not_allowed` | 403 |
| `password_change_required` | 403 |
| `attestation_failed` | 422 + `reason` |
| `attestation_status_unavailable` | 422 |
| `not_personal_device` | 403 |
| `enroll_window_closed` | 403 |
| `bad_signature` | 401 |
| `bad_challenge` | 401 |

### Copy (verbatim)
- "Use fingerprint or face to sign in on this phone? You'll sign in with your password again every 30 days." with buttons "Turn on" / "Not now"
- "Sign in as {display_name}"
- "Other account"
- "Use password"
- "Sign in with your password to keep using fingerprint."
- "Your password needs changing in the portal."
- "This phone can't use fingerprint sign-in."
- "Fingerprint sign-in: On · Forget this device"
- Portal: "Personal device", "Fingerprint on · renews by {Mon D}", "Biometric sign-in"

### Gates
- **API:** `SS_TEST_DB=serversherpa_test_bio`. The tests need the main checkout's `.env` and `api/.venv`: symlink them in for the runs, then remove the symlinks. Run the full suite in foreground chunks under 10 minutes each.
- **Android:** `./gradlew testDebugUnitTest assembleDebug`.
- **Portal:** `npm test` + `npm run build` in `portal/`.

## Review Focus

1. **The 30-day boundary.** A sign-in at exactly 30 days minus 1 s works, and at 30 days it returns `biometric_expired`. Test in Task 3 with a frozen clock.
2. **Replay.** Reusing a challenge, or replaying a captured signature, fails. A second challenge for the same key invalidates the first. Test in Task 3.
3. **Device reassigned, or person disabled, while the card is showing.** The next sign-in is refused with the right code, and the app falls back to the password form with a message. Test in Tasks 3 and 7.
4. **Android invalidated the key** (new fingerprint or lock removed: `KeyPermanentlyInvalidatedException`). The app deletes the local key and shows the password form, with no crash or loop. Test in Task 6.
5. **Move-password sessions, Time Clock stations and station-key devices.** They never see the card or the enroll offer, and the server refuses enroll for them. Test in Tasks 3 and 7.

---

### Task 1: Schema and session login method (API)

**Files:**
- Create: `api/migrations/versions/0107_biometric_sign_in.py`
- Modify: `API/db/models.py`
  - `Device`: add `personal_person_id`, `personal_set_at`, `personal_set_by`.
  - `AuthSession`: add `login_method`.
  - New `BiometricKey`.
- Modify: `API/services/auth.py`
  - `start_session(…, login_method: str)` is a required keyword.
  - The refresh rotation copies `login_method`.
- Modify: the callers of `start_session`:
  - `routes/auth.py` `/auth/login` → `password`
  - `_finish_challenge` → `password`
  - `routes/kiosk.py` pair poll → `link`
  - move-login → `move`
  - any others `grep start_session` finds: CLI, invites and others take `password` unless they clearly are not.
- Test: `api/tests/test_biometric_schema.py`

**Interfaces:**
- Produces:
  - `BiometricKey` with columns `id`, `person_id` (FK people, CASCADE), `device_id` (FK devices, CASCADE), `public_key` (LargeBinary, DER SubjectPublicKeyInfo), `key_alg` ("ES256"), `security_level` ("tee" | "strongbox"), `created_at`, `password_sign_in_at`, `last_used_at`, `last_nonce` (Text, nullable), `revoked_at`, `revoke_reason`.
  - A partial unique index `(person_id, device_id) WHERE revoked_at IS NULL`.
  - `AuthSession.login_method: str | None`.
  - `Device.personal_person_id` (FK people SET NULL), `personal_set_at`, `personal_set_by` (FK people SET NULL).

- [ ] **Step 1: Failing tests.**
  - `test_password_login_records_method`: kiosk `/auth/login`, then the session row has `login_method == "password"`.
  - `test_refresh_keeps_method`: refresh rotates, and the new row keeps `"password"`.
  - `test_pair_and_move_record_their_methods`.
  - `test_one_live_key_per_person_device`: a second live insert raises IntegrityError; a revoked one plus a new one is fine.
  - `test_migration_round_trip`: downgrade to 0106, then upgrade to head.
- [ ] **Step 2:** Run, watch them fail.
- [ ] **Step 3:** Implement the migration, models and `start_session` plumbing.
- [ ] **Step 4:** Run the auth, kiosk-pairing, move-password and devices test files, plus the new file. All green.
- [ ] **Step 5:** Commit `feat(api): sessions record how they signed in; biometric keys and personal devices in the schema`.

### Task 2: Key attestation verifier (API)

**Files:**
- Create: `API/security/key_attestation.py`
- Create: `API/security/attestation_roots/` (the pinned Google roots as PEM, from Google's key-attestation docs)
- Create: `API/security/attestation_status.py` (revocation-list fetch and cache)
- Modify: `api/pyproject.toml` (add `pyasn1>=0.6`)
- Modify: `API/config.py`: `kiosk_signing_digests: list[str]` from `SS_KIOSK_SIGNING_DIGESTS` (comma-separated hex SHA-256), plus `attestation_status_url` defaulting to `https://android.googleapis.com/attestation/status`.
- Modify: `API/notifications/worker.py`, so `run_forever` refreshes the status list once a day. Name the function `refresh_attestation_status(db) -> None`; it stores `{fetched_at, entries}` under system config key `attestation_status`.
- Test: `api/tests/test_key_attestation.py`, with generated chains. A test-only fixture builds a fake root and intermediate, and a leaf carrying a pyasn1-encoded KeyDescription. The verifier takes `roots=` for injection.

**Interfaces:**
- Produces:
  - `verify_attestation(chain_der: list[bytes], *, nonce: bytes, digests: set[str], status: AttestationStatus, roots: list[x509.Certificate] | None = None, now: datetime | None = None) -> AttestedKey`
  - `AttestedKey(public_key_der: bytes, security_level: Literal["tee", "strongbox"])`
  - `AttestationError(reason: str)`, with reasons `chain`, `root`, `expired`, `revoked`, `challenge`, `security_level`, `key_properties`, `user_auth`, `package`, `boot_state`, `parse`
  - `load_status(db) -> AttestationStatus | None`
  - `AttestationStatus(fetched_at, revoked_serials: set[str])`, with the method `.fresh(now) -> bool` (≤ 7 days)

- [ ] **Step 1: Failing tests.**
  - Positive: `test_good_chain_attests` returns StrongBox and the leaf key.
  - Negatives: `test_software_level_refused` (`security_level`), `test_wrong_challenge_refused`, `test_unknown_root_refused`, `test_revoked_intermediate_refused`, `test_wrong_package_refused`, `test_unlisted_digest_refused`, `test_unlocked_boot_refused`, `test_no_auth_required_refused`, `test_auth_timeout_refused`, `test_rsa_key_refused`, `test_expired_cert_refused`, `test_garbage_refused` (`parse`).
  - Status: `test_status_stale_after_7_days`.
- [ ] **Step 2:** Run, watch them fail.
- [ ] **Step 3:** Implement.
  - Verify each signature with `cryptography`.
  - Decode the extension with a pyasn1 KeyDescription schema covering versions 3–300. Field tags follow Google's schema doc. `attestationApplicationId` is an OCTET STRING wrapping its own DER.
  - Never use the extension of any certificate but the leaf.
- [ ] **Step 4:** Run, all green.
- [ ] **Step 5:** Commit `feat(api): verify Android key attestation for biometric keys`.

### Task 3: Biometric service and kiosk routes (API)

**Files:**
- Create: `API/services/biometric.py`
- Create: `API/api/routes/kiosk_biometric.py`, mounted under `/kiosk/biometric`
- Modify: `API/api/schemas.py`
- Modify: `API/api/deps.py`, so challenge and sign-in skip the read-only freeze and forget is exempt, like the self-service trusted-browser forget
- Modify: `routes/kiosk.py` `_bind_kiosk_session`, which renews `password_sign_in_at` when the bound session's `login_method == "password"`
- Modify: `HeartbeatIn.login_method`, which gains `"biometric"`
- Test: `api/tests/test_kiosk_biometric_api.py`

**Interfaces:**
- Consumes: Task 1 models, Task 2 `verify_attestation`.
- Produces routes:
  - `POST /kiosk/biometric/enroll-challenge {serial}` → `{nonce}`
  - `POST /kiosk/biometric/enroll {serial, nonce, chain: [base64 DER]}` → `{key_id, security_level, renews_at}`
  - `POST /kiosk/biometric/challenge {serial}` → `{key_id, challenge, display_name, photo_url, expired}`
  - `POST /kiosk/biometric/sign-in {key_id, challenge, signature: base64 DER ECDSA}` → the same `SessionOut` body as `/auth/login`, and it sets the `ss_refresh` cookie
  - `DELETE /kiosk/biometric?serial=` → 204
- Produces service:
  - `revoke_keys(db, *, person_id=None, device_id=None, reason: str) -> int`, used by Tasks 4 and 5
  - `renew_on_password_bind(db, person_id, device_id) -> None`
- Signing: the app signs the UTF-8 bytes of the challenge string with `SHA256withECDSA`.
- Sign-in rate limit: reuse move-login's failure-cap helper.
- Audit actions: `biometric_enroll`, `login_biometric`, `biometric_forget`, `biometric_revoke`.

- [ ] **Step 1: Failing tests.** Patch `verify_attestation` to return a software-generated key, so these tests sign with `cryptography`.
  - Enroll:
    - `test_enroll_needs_password_session_within_10_minutes`: a link, move or biometric session gets `enroll_window_closed`, and so does a password session older than 10 minutes.
    - `test_enroll_needs_personal_device`: `not_personal_device`.
    - `test_enroll_replaces_older_key`
    - `test_enroll_refused_when_status_stale`: `attestation_status_unavailable`.
  - Challenge:
    - `test_challenge_404_without_key`
    - `test_challenge_never_returns_email`
    - `test_challenge_expired_flag`
  - Sign-in:
    - `test_sign_in_mints_kiosk_session_with_biometric_method`
    - `test_sign_in_expiry_boundary` (Review Focus 1)
    - `test_challenge_single_use` and `test_new_challenge_voids_old` (Review Focus 2)
    - `test_bad_signature`
    - `test_device_reassigned_refuses`
    - `test_disabled_account_refuses`
    - `test_without_kiosk_view_refuses`
    - `test_expired_password_refuses`
    - `test_move_identity_never_enrolls` (Review Focus 5)
  - Renewal and freeze:
    - `test_password_bind_renews_anchor`
    - `test_heartbeat_reported_password_does_not_renew_biometric_session`
    - `test_read_only_freeze_allows_challenge_sign_in_forget_not_enroll`
    - `test_sign_in_failures_rate_limited`
- [ ] **Step 2:** Run, watch them fail.
- [ ] **Step 3:** Implement. Sign-in reuses `start_session(client="kiosk", login_method="biometric", audit_action="login_biometric")`, plus the same cookie setting `/auth/login` uses.
- [ ] **Step 4:** Run, all green.
- [ ] **Step 5:** Commit `feat(api): kiosk biometric enroll, challenge, sign-in and forget`.

### Task 4: Revocation hooks (API)

**Files:**
- Modify each lifecycle path the spec lists, calling `biometric.revoke_keys(…, reason=…)` beside the existing session revoke:
  - `routes/users.py`: admin reset-password, disable, demote (explicit revoke before the account delete), per-person revoke-all
  - `services/password_reset.py`: self-service reset or invite
  - `routes/me.py`: own password change, which revokes all of their keys
  - `api/worker_edits.py` and `people/bulk_import.py`: blacklist
  - `routes/system.py`: global revoke-all, as a bulk update
- Test: `api/tests/test_biometric_revocation.py`

**Interfaces:** Consumes Task 3 `revoke_keys`.

- [ ] **Step 1: Failing tests.** One per path, each asserting the key is revoked with the expected reason: `password_change`, `account_disabled`, `demoted`, `admin`, `blacklist`. Add `test_un_blacklist_keeps_key_revoked`.
- [ ] **Step 2:** Run, fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run these files plus the users, me, workers, system and password-reset test files. Green.
- [ ] **Step 5:** Commit `feat(api): every account and session revoke also revokes biometric keys`.

### Task 5: Admin and self-service routes (API)

**Files:**
- Modify: `routes/devices.py`
  - `PUT /devices/{id}/personal {person_id: UUID | null}` requires `scanning_hardware:change` plus rank 80, the same gate as the page's other writes. It revokes the previous person's key on that device with reason `reassigned`.
  - `DELETE /devices/{id}/biometric` uses the same gate.
  - `DeviceDetail` gains `personal_person {id, display_name} | null` and `personal_biometric {on: bool, renews_at} | null`.
- Modify: `routes/users.py`
  - `GET /users/{id}/biometric-keys`, gated by users:view plus the same `_may_see_device_details` rule as trusted browsers.
  - `DELETE /users/{id}/biometric-keys/{key_id}` and `DELETE /users/{id}/biometric-keys`, gated by users:change.
- Modify: `routes/me.py`
  - `GET /auth/me/biometric-keys` and `DELETE /auth/me/biometric-keys/{key_id}`, both exempt from the freeze like the trusted-browser routes.
- Picker validation: the person needs a `UserAccount`, `kiosk:view`, and `source != "kiosk_move"`. Otherwise return 422 `not_eligible`.
- Test: `api/tests/test_biometric_admin_api.py`

**Interfaces:**
- Produces `BiometricKeyOut {id, device_id, device_name, security_level, created_at, last_used_at, renews_at}`.

- [ ] **Step 1: Failing tests.** Gates (rank 79 is refused), eligibility, reassignment revoking the key, list contents, and that forget really revokes.
- [ ] **Step 2:** Run, fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, green. Then run the full API suite in chunks.
- [ ] **Step 5:** Commit `feat(api): personal devices and biometric key lists for admins and /me`.

### Task 6: Android data layer

**Files:**
- Modify: `Android_Kiosk_App/gradle/libs.versions.toml` and `app/build.gradle.kts`: add `androidx.biometric:biometric:1.1.0`.
- Create: `APP/data/auth/BiometricKeys.kt`
  - An interface `BiometricKeys` with `canUse(): BiometricReadiness`, `create(nonce: ByteArray): List<ByteArray>` (the attestation chain), `signer(): Signature?` (null once invalidated), and `delete()`.
  - The Android implementation sits on `AndroidKeyStore` with alias `ss_biometric_signin`.
- Create: `APP/data/auth/BiometricSignIn.kt`, which owns the flow: `offerEnroll()`, `enroll(prompt)`, `card(): BiometricCard?` (from `/challenge`), `signIn(prompt)`, and `forget(signedIn: Boolean)`. It stores the key id and email in KioskPrefs.
- Modify: `APP/data/api/KioskApi.kt` and `OkHttpKioskApi.kt`, which gain the five routes.
- Modify: `APP/data/auth/KioskAuth.kt`: `LoginMethod.BIOMETRIC` and `signInWithBiometric(result)`.
- Modify: `core/model/Session.kt` if needed.
- Test: `APPT/data/auth/BiometricSignInTest.kt`, using `FakeBiometricKeys` and a fake API.

**Interfaces:**
- Produces:
  - `BiometricReadiness { READY, NO_HARDWARE, NONE_ENROLLED, NO_SECURE_LOCK }`
  - `BiometricCard(keyId, challenge, displayName, photoUrl, expired, email)`, where `email` comes from local prefs
  - `sealed BiometricOutcome { SignedIn, Expired, PasswordChange, NotAllowed, Invalidated, Canceled, Failed(message) }`
  - A prompt seam, `suspend fun authenticate(signature: Signature): Signature?`, so the UI supplies the BiometricPrompt and tests fake it.

- [ ] **Step 1: Failing tests.**
  - `enrollSendsChainAndStoresKeyId`
  - `cardNullWithoutLocalKey`
  - `signInSignsTheChallengeBytes`
  - `expiredMapsToExpired`
  - `passwordChangeMapsToPasswordChange`
  - `notAllowedMaps`
  - `invalidatedKeyIsDeletedLocallyAndFallsBack` (Review Focus 4)
  - `forgetSignedOutDeletesLocallyOnly`
  - `forgetSignedInCallsServer`
  - `canceledPromptStaysOnCard`
  - `moveSessionNeverOffersEnroll`
- [ ] **Step 2:** Run, fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, green.
- [ ] **Step 5:** Commit `feat(android): biometric keys, enroll and sign-in flow`.

### Task 7: Android UI

**Files:**
- Modify: `APP/ui/screens/login/LoginScreen.kt` and `LoginViewModel.kt`. Add a `BIOMETRIC` view: the "Sign in as {name}" card with the photo and the auto prompt, Use password, Other account (opening the existing CHOOSER), the expired state (the password form pre-filled with the email plus the expired line), and the password-change message.
- Create: `APP/ui/screens/login/BiometricPrompting.kt`: an `androidx.biometric.BiometricPrompt` with `CryptoObject(signature)` and `BIOMETRIC_STRONG`. This needs a `FragmentActivity`; switch MainActivity's base class if it isn't one already, and note that in the report.
- Create: `APP/ui/screens/login/EnrollOfferSheet.kt`, the sheet shown after a password sign-in when `offerEnroll()` says yes.
- Modify: `APP/ui/screens/settings/ThisKioskPanel.kt`, adding the "Fingerprint sign-in: On · Forget this device" row, or info text when the device isn't personal to the signed-in person.
- Test: `APPT/ui/screens/login/BiometricLoginTest.kt` (Compose, 320 dp) and `EnrollOfferSheetTest.kt`.

**Interfaces:** Consumes Task 6.

- [ ] **Step 1: Failing tests.**
  - `cardShowsNameAndOtherAccount`
  - `otherAccountOpensChooser`
  - `expiredShowsPrefilledEmailAndLine`
  - `passwordChangeShowsPortalMessage`
  - `reassignedFallsBackToPasswordWithMessage` (Review Focus 3)
  - `noCardForMoveLockedOrTimeClockStation` (Review Focus 5)
  - `enrollOfferAfterPasswordSignInOnPersonalDevice`
  - `notNowAsksAgainNextPasswordSignIn`
  - `thisKioskRowForgets`
  - `cardFits320dp`
- [ ] **Step 2:** Run, fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full Android gate.
- [ ] **Step 5:** Commit `feat(android): sign in with fingerprint or face on a personal device`.

### Task 8: Portal

**Files:**
- Modify: `portal/src/components/hardware/kiosk/KioskOverviewTab.tsx`: a "Personal device" row with a person picker (the existing dir-search), the fingerprint status ("Fingerprint on · renews by {Mon D}"), Clear, and Forget fingerprint.
- Create: `portal/src/components/users/UserBiometricKeys.tsx`, modeled on `UserTrustedBrowsers.tsx`, and use it on the user page and in `portal/src/pages/Profile.tsx` (/me).
- Modify: `portal/src/lib/api.ts`.
- Tests: the matching `*.test.tsx` files.

- [ ] **Step 1: Failing tests.** Picker save and clear; the read-only view without rights; the user panel lists and forgets; the /me panel forgets.
- [ ] **Step 2:** Run, fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` and `npm run build`, green.
- [ ] **Step 5:** Commit `feat(portal): personal devices and biometric sign-in panels`.

### Task 9: Docs and device pass

**Files:**
- `Android_Kiosk_App/README.md`: a Sign-in section.
- The spec: an Implementation notes section.

- [ ] **Step 1:** Update the README.
- [ ] **Step 2: Device pass** (the controller with Jimmy):
  1. In the portal, assign the Pixel to Jimmy.
  2. Sign in with a password, then Turn on.
  3. Sign out, then sign in with a fingerprint.
  4. Cancel the prompt, then Use password.
  5. Other account opens the chooser.
  6. Add a fingerprint to the phone: the key is invalidated and the app falls back to the password.
  7. Forget the device from the app, then from /me.
  8. Clear the assignment in the portal: the card disappears.
  9. Record the attestation security level. Capture the Pixel's real chain as a test fixture with no secrets in it: the chain is public certificates.
  10. If an MC2200 is available, check that its chain reaches a Google root.
- [ ] **Step 3:** Commit `docs: biometric sign-in README and implementation notes`.
