# iOS Biometric Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the person an iPad or iPhone is assigned to sign in to the kiosk app with Face ID or Touch ID. This is the iOS port of Android biometric sign-in, with Apple App Attest proving the key at enrollment.

**Architecture:**
- The server's existing `/kiosk/biometric/*` routes stay. Only enroll gains an iOS branch: it verifies an App Attest statement bound to the Secure Enclave key, then checks a proof signature from that key, and stores it as `secure_enclave`.
- The iOS app gets:
  - a Secure Enclave key store behind a protocol;
  - a LocalAuthentication prompter;
  - a `BiometricSignIn` rules object ported from Android;
  - the login card, the enroll offer sheet and a Settings row.

**Tech Stack:**
- Server: FastAPI, SQLAlchemy and Alembic, `cryptography`, plus new `cbor2`.
- iOS: Swift 5, SwiftUI, Swift Testing, LocalAuthentication, DeviceCheck (App Attest), Security and CryptoKit.

**Spec:** `docs/superpowers/specs/2026-11-09-ios-biometric-sign-in-design.md`. It builds on `docs/superpowers/specs/2026-10-23-kiosk-biometric-sign-in-design.md`, including that spec's Implementation notes.

**Recon maps:** these are scratch notes, not requirements.
- `/private/tmp/claude-501/-Users-jrh1812-Developer-BaseCampV3/83c85735-b7ea-4313-9fa5-a69362b2a6ef/scratchpad/bio-recon/server.md`
- `…/bio-recon/android.md`
- `…/bio-recon/ios.md`

They give file:line maps of the server, the Android client being ported, and the iOS app.

**Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/ios-biometric`, on branch `ios-biometric-sign-in`, cut from main `7e5cf5eb8`.

## Global Constraints

**Server and test setup**
- **Dependency.** `cbor2>=5.6` goes in `api/pyproject.toml` `[project].dependencies`. Install it into the venv the tests use.
- **Running API tests.**
  - Run from `api/`: `.venv/bin/pytest …`, with `SS_TEST_DB=serversherpa_test_iosbio`.
  - The worktree has no `.env` or `api/.venv`. Symlink both from `/Users/jrh1812/Developer/BaseCampV3`, and never commit the symlinks.
  - The dev Postgres is at 127.0.0.1:5433.
- **iOS tests and builds.** Run from `IOS_Kiosk_App/ServerSherpa Kiosk/` with `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
  - Tests: `xcodebuild test -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,name=iPad Air 11-inch (M3),OS=18.5' -derivedDataPath ../.derived-iosbio -only-testing:"ServerSherpa KioskTests"`
  - Build: `xcodebuild build -scheme "ServerSherpa Kiosk" -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.5' -derivedDataPath ../.derived-iosbio`

**Fixed values**
- App ID constant: `KIOSK_IOS_APP_ID = "Y2QYBG96U4.Server-Sherpas.ServerSherpa-Kiosk"`.
- App Attest extension OID: `1.2.840.113635.100.8.2`.
- Production aaguid: `b"appattest" + b"\x00" * 7`. Development aaguid: `b"appattestdevelop"`.
- `clientDataHash = SHA256(UTF-8(nonce) ‖ public_key_x963)`.
  - Shared test vector: nonce `"enroll-nonce"` and public key `bytes([4]) + bytes(range(1, 65))` give hex `e66ae6444b04ccdff839a7a0d5041d2bf2b1797a3ffdcddfd7e59fd5828df43a`.
- New security level value: `"secure_enclave"`.
- Setting: `SS_KIOSK_APP_ATTEST_DEVELOPMENT`, a bool defaulting to false (`Settings.kiosk_app_attest_development`).
- The iOS entitlement is `com.apple.developer.devicecheck.appattest-environment = production`.

**Rules**
- **Apple root location.** The Apple root PEM goes in `api/src/serversherpa/security/app_attest_roots/`, never in `attestation_roots/`. `google_roots()` trusts every `.pem` in that folder.
- **iOS layout rule.** `Core/` imports Foundation only (`CorePurityTests`). LocalAuthentication, DeviceCheck, Security, CryptoKit and UIKit code lives in `Data/Auth/`.
- **Copy.** All user-facing copy is the spec's "Copy (iOS)" table, verbatim. `<Bio>` is "Face ID" or "Touch ID", and `<device>` is "iPad" or "iPhone".
- **Language.** All code comments, docs and copy use American English.
- **Out of scope.** No portal (`portal/`), Android or deploy/Sirdar changes.

## Review Focus

These are the failure modes the spec implies that are most likely to bite. Each has a pinned test in the task named.

1. **A Keychain or Secure Enclave call that throws.** It must never forget the key, and the card must not vanish for good. Tested in Task 5: `aThrowingKeyStoreIsUnusableThisTimeAndKeepsTheKey`.
2. **A late `/challenge` answer arriving after the person started typing.** It must never replace the form. Tested in Task 6: `aLateCardNeverReplacesAStartedForm`.
3. **Signing out while Turn on's Face ID prompt is up.** The sheet must stay closed and no enrollment may be stored. Tested in Task 6: `signingOutDuringTurnOnStopsItAndTheSheetStaysClosed`.
4. **A move-password or pair sign-in on a personal iPad.** It must never be offered enrollment, even though iOS's `lastSignIn` reports a move password as `.password`. Tested in Task 3 (`moveLoginLeavesNoCurrentSignIn`) and Task 5 (`moveOrPairSignInNeverOffers`).
5. **A malformed iOS enroll body.** That covers a 64-byte key, a point not on the curve, a non-base64 attestation, and Android and iOS fields mixed. Each must be refused with 422 and never a 500. Tested in Task 2: `iosEnrollMalformedFieldsAre422`.

---

### Task 1: Server App Attest verifier

**Files:**
- Create: `api/src/serversherpa/security/app_attest.py`
- Create: `api/src/serversherpa/security/app_attest_roots/apple_app_attestation_root_ca.pem` and `README.md` (source URL and SHA-256 fingerprint)
- Modify: `api/src/serversherpa/security/key_attestation.py:61` (the `Reason` Literal)
- Modify: `api/pyproject.toml` (the `cbor2>=5.6` dependency, and package-data `"app_attest_roots/*.pem", "app_attest_roots/README.md"` under `serversherpa.security`)
- Create: `api/tests/app_attest_helpers.py` and `api/tests/test_app_attest.py`

**Interfaces:**
- Consumes: `AttestationError(reason, detail="")` from `key_attestation.py`.
- Produces:
  - `KIOSK_IOS_APP_ID: str`
  - `APP_ATTEST_OID: x509.ObjectIdentifier`
  - `PRODUCTION_AAGUID: bytes`, `DEVELOPMENT_AAGUID: bytes`
  - `apple_app_attest_root() -> x509.Certificate`, cached
  - `client_data_hash(nonce: str, public_key_x963: bytes) -> bytes`
  - `verify_app_attest(attestation: bytes, *, key_id: bytes, client_data_hash: bytes, app_id: str = KIOSK_IOS_APP_ID, allow_development: bool, roots: list[x509.Certificate] | None = None, now: datetime | None = None) -> None`. It raises `AttestationError`.
  - `Reason` gains `"format", "key_id", "app_id", "counter", "environment", "proof"`.

- [ ] **Step 1: Fetch and pin Apple's root.**
  - Download `https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem` with curl into `app_attest_roots/apple_app_attestation_root_ca.pem`.
  - Confirm the subject CN is "Apple App Attestation Root CA" and the key is EC P-384.
  - Record its SHA-256 DER fingerprint in `README.md` together with the URL.

- [ ] **Step 2: Write `tests/app_attest_helpers.py`.** Write it independently of the verifier's parsing.
  - It builds a test root (P-384) and an intermediate (P-384).
  - It builds a credential certificate whose P-256 key carries extension `1.2.840.113635.100.8.2`. The extension value is DER `SEQUENCE { [1] EXPLICIT OCTET STRING nonce }`.
  - It builds authData in this layout:
    - `rpIdHash` (32 bytes)
    - `flags` (1 byte, `0x40`)
    - `signCount` (4 bytes, big-endian)
    - `aaguid` (16 bytes)
    - `credIdLen` (2 bytes, big-endian)
    - `credId`
    - a CBOR COSE key
  - The CBOR object is `{"fmt": "apple-appattest", "attStmt": {"x5c": [cred_der, inter_der], "receipt": b""}, "authData": auth}`, encoded with `cbor2`.
  - It exposes `make_attestation(**breaks) -> Built(obj: bytes, root: x509.Certificate, key_id: bytes, client_data_hash: bytes)`. Each keyword breaks exactly one thing:
    - `fmt`
    - `x5c` (an override list)
    - `aaguid`
    - `counter`
    - `app_id`
    - `cred_id`
    - `nonce_override` (puts the wrong nonce in the extension)
    - `no_extension`
    - `cred_not_after`
    - `root_key_name` (signs with an unpinned root)
    - `auth_data` (a raw override)
  - Its constants are `NOW = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)` and `CDH = sha256(b"client-data").digest()`.

- [ ] **Step 3: Write the failing tests in `tests/test_app_attest.py`.** Each refusal asserts `exc.value.reason == <reason>`. All tests pass `roots=[built.root], now=NOW` and `client_data_hash=built.client_data_hash`.

  | Test | Expected |
  |---|---|
  | `test_production_attestation_passes` | returns None, with `allow_development=False` |
  | `test_development_aaguid_needs_allow_development` | `environment` when False; passes when True |
  | `test_unknown_aaguid_is_environment` | `environment` |
  | `test_wrong_root_is_root` | `root` |
  | `test_broken_chain_is_chain` | `chain` (x5c swapped or missing intermediate) |
  | `test_expired_credential_cert_is_expired` | `expired` |
  | `test_nonce_mismatch_is_challenge` | `challenge`; also a different `client_data_hash` gives `challenge` |
  | `test_missing_extension_is_challenge` | `challenge` |
  | `test_key_id_not_hash_of_cert_key` | `key_id` |
  | `test_credential_id_mismatch_is_key_id` | `key_id` |
  | `test_app_id_mismatch` | `app_id` |
  | `test_nonzero_counter` | `counter` |
  | `test_not_cbor_is_parse` | `parse` |
  | `test_short_auth_data_is_parse` | `parse` |
  | `test_wrong_fmt_is_format` | `format` |
  | `test_missing_x5c_is_format` | `format` |
  | `test_client_data_hash_vector` | `client_data_hash("enroll-nonce", bytes([4]) + bytes(range(1, 65))).hex() == "e66ae6444b04ccdff839a7a0d5041d2bf2b1797a3ffdcddfd7e59fd5828df43a"` |
  | `test_pinned_apple_root` | `sha256(apple_app_attest_root().public_bytes(DER)).hexdigest()` equals the README fingerprint, and the CN is "Apple App Attestation Root CA" |
  | `test_google_roots_unchanged` | `len(google_roots()) == 5` |

- [ ] **Step 4: Run the tests to verify they fail.**
  - Run `cd api && SS_TEST_DB=serversherpa_test_iosbio .venv/bin/pytest tests/test_app_attest.py -q`.
  - Expected: an ImportError on `serversherpa.security.app_attest`.

- [ ] **Step 5: Implement `security/app_attest.py`.**
  - The checks run in the spec's order (App Attest verification, steps 1–8).
  - `cbor2.loads` failures are `parse`.
  - Chain links use `cert.verify_directly_issued_by(issuer)`. The top certificate must be issued by a pinned root, compared by SPKI.
  - Every certificate's validity, including the root's, must cover `now`.
  - The credential certificate's key is compared as `public_bytes(X962, UncompressedPoint)`.
  - Use `hmac.compare_digest` for the nonce, `rpIdHash` and `key_id` comparisons.

- [ ] **Step 6: Run the tests to verify they pass.**
  - Run the command from Step 4. Expected: all pass.
  - Then run `.venv/bin/pytest tests/test_key_attestation.py -q`. Expected: all still pass.

- [ ] **Step 7: Commit.**
  - `git add api/src/serversherpa/security/app_attest.py api/src/serversherpa/security/app_attest_roots api/src/serversherpa/security/key_attestation.py api/pyproject.toml api/tests/app_attest_helpers.py api/tests/test_app_attest.py`
  - `git commit -m "feat(api): App Attest verifier for iOS biometric enroll"`

---

### Task 2: Server iOS enroll branch, migration 0124 and setting

**Files:**
- Create: `api/migrations/versions/0124_biometric_secure_enclave.py` (revision `"0124"`, down `"0123"`)
- Modify:
  - `api/src/serversherpa/api/schemas.py`: `BiometricEnrollIn` at L497, `BiometricEnrollOut` at L512, `BiometricKeyOut` at L3579
  - `api/src/serversherpa/services/biometric.py`: `enroll` at L266, plus the new `enroll_ios`
  - `api/src/serversherpa/api/routes/kiosk_biometric.py`: `enroll` at L129
  - `api/src/serversherpa/config.py`: the setting
  - `api/src/serversherpa/db/models.py:1308`: the comment
- Create: `api/tests/test_kiosk_biometric_ios_api.py`
- Modify: `api/tests/test_biometric_schema.py`

**Interfaces:**
- Consumes (from Task 1): `verify_app_attest`, `client_data_hash` and `KIOSK_IOS_APP_ID`. Import these in `services/biometric.py` as module attributes, so tests can monkeypatch `biometric.verify_app_attest`.
- Produces:
  - `SecurityLevel = Literal["tee", "strongbox", "secure_enclave"]` in schemas, used by both outputs.
  - `BiometricEnrollIn`:
    - `platform: Literal["android", "ios"] = "android"`
    - `chain: list[str] | None`, with the old size rules
    - `public_key: str | None` (max length 128)
    - `app_attest_key_id: str | None` (max 64)
    - `attestation: str | None` (max 32768)
    - `signature: str | None` (max 512)

    A `model_validator` enforces the field sets: Android needs `chain` and no iOS fields; iOS needs all four iOS fields and no `chain`.
  - `async def enroll_ios(db, *, person_id: uuid.UUID, device: Device, nonce: str, public_key_x963: bytes, app_attest_key_id: bytes, attestation: bytes, proof: bytes, password_sign_in_at: datetime, ip: str | None = None) -> BiometricKey`
  - `Settings.kiosk_app_attest_development: bool = False`

- [ ] **Step 1: Write the failing tests in `tests/test_kiosk_biometric_ios_api.py`.**
  - Reuse `test_kiosk_biometric_api.py`'s helpers by import: `_worker_on_phone`, `_enroll_challenge`, `_challenge`, `_sign_in`, `_code`. Use `mode: "ios"` serials `ios-bio-*`, and copy `_beat`'s body with `"mode": "ios"` if needed.
  - Add a `FakeAppAttest` fixture patched at `biometric.verify_app_attest`. It records its kwargs and raises `.error` if set.
  - The device key is a software `ec.generate_private_key(SECP256R1())`, exported as X962 UncompressedPoint. The proof is `key.sign(nonce.encode(), ECDSA(SHA256()))`.

  | Test | Expected |
  |---|---|
  | `iosEnrollStoresSecureEnclaveKeyAndSignInWorks` | enroll gives 200 with `security_level == "secure_enclave"`; then `_challenge` → sign with the same software key → `_sign_in` gives 200 and a session |
  | `iosEnrollBindsNonceAndKeyIntoClientDataHash` | `fake.calls[0]["client_data_hash"] == sha256(nonce.encode() + pub).digest()`, `app_id == KIOSK_IOS_APP_ID`, `key_id` equals the decoded `app_attest_key_id`, `attestation` equals the decoded bytes |
  | `iosEnrollFollowsTheDevelopmentSetting` | `allow_development` is False by default and True when `get_settings().kiosk_app_attest_development` is patched True |
  | `iosEnrollSkipsTheGoogleStatusGate` | `biometric.load_status` patched to return None; enroll still gives 200 |
  | `iosAttestationRefusedIs422WithReason` | fake raises `AttestationError("environment")`; 422 with `_code == "attestation_failed"` and `detail.reason == "environment"`; no key row |
  | `iosBadProofIs422Proof` | the proof is signed over a different message; 422 `attestation_failed` with reason `proof`; no key row |
  | `iosEnrollMalformedFieldsAre422` | a 64-byte key, a 65-byte point off the curve, non-base64 `attestation`, a 31-byte key id, a body with both `chain` and iOS fields, and an iOS body missing `signature`: every one gives 422 and none gives 500 |
  | `iosEnrollUsesTheSameGate` | not a personal device gives 403 `not_personal_device`; a reused nonce gives 422 `bad_enroll_nonce` |
  | `iosEnrollAuditRecordsPlatform` | the `biometric_enroll` audit `changes["platform"] == "ios"` and `security_level == "secure_enclave"`; an Android enroll records `"android"` |
  | `iosKeyListsAsSecureEnclave` | `GET /auth/me/biometric-keys` gives `[0]["security_level"] == "secure_enclave"` |

  In `test_biometric_schema.py`, add `test_secure_enclave_level_allowed_at_head` (inserting a `secure_enclave` key succeeds). The existing round-trip test must still pass.

- [ ] **Step 2: Run the tests to verify they fail.**
  - Run `.venv/bin/pytest tests/test_kiosk_biometric_ios_api.py tests/test_biometric_schema.py -q`.
  - Expected: failures, either 422 on the `platform` field or the check constraint.

- [ ] **Step 3: Implement.**
  - **Migration.** Drop and recreate `ck_biometric_keys_security_level` with `IN ('tee', 'strongbox', 'secure_enclave')`. The downgrade deletes `secure_enclave` rows, then restores the narrower check.
  - **`enroll_ios`.**
    1. Validate `public_key_x963` with `ec.EllipticCurvePublicKey.from_encoded_point(SECP256R1(), raw)`, requiring exactly 65 bytes starting `0x04`. Validate the key id as exactly 32 bytes. A failure is `BiometricError(422, "attestation_failed", reason="parse")`.
    2. Call `verify_app_attest(..., client_data_hash=client_data_hash(nonce, raw), allow_development=get_settings().kiosk_app_attest_development)`. An `AttestationError` is logged and becomes `BiometricError(422, "attestation_failed", reason=exc.reason)`.
    3. Check `signature_valid(spki, nonce, proof)`. If false, that is reason `proof`.
    4. Store through a shared `_store_key(db, *, person_id, device, public_key_der, security_level, platform, password_sign_in_at, ip)`. Android's `enroll` uses it too, so both audits record `platform`.
  - **Route.** Branch on `body.platform`. Decode the base64 fields with `validate=True`; a failure is 422 `attestation_failed` with reason `parse`. Keep the gate, the nonce decoding and the nonce-spent check exactly as they are.
  - **Setting.** Add it with the comment "Accept Apple's development App Attest environment (dev only)".

- [ ] **Step 4: Run the tests to verify they pass.**
  - Run the command from Step 2, plus `tests/test_kiosk_biometric_api.py tests/test_biometric_revocation.py tests/test_biometric_admin_api.py tests/test_key_attestation.py tests/test_app_attest.py`.
  - Expected: all pass.

- [ ] **Step 5: Commit.**
  - `git commit -m "feat(api): iOS biometric enroll with App Attest (migration 0124)"`

---

### Task 3: iOS API, models, auth and prefs

Paths are relative to `IOS_Kiosk_App/ServerSherpa Kiosk/`. IK is `ServerSherpa Kiosk/` and IT is `ServerSherpa KioskTests/`.

**Files:**
- Create: `IK/Core/Model/Biometric.swift`
- Modify:
  - `IK/Data/Api/KioskApi.swift`: a new `// MARK: biometric sign-in` group
  - `IK/Data/Api/URLSessionKioskApi.swift`
  - `IK/Data/Auth/KioskAuth.swift`
  - `IK/Data/Prefs/KioskPrefs.swift`
  - `IT/Support/FakeKioskApi.swift`
- Create: `IT/Data/URLSessionKioskApiBiometricTests.swift`
- Modify: `IT/Data/KioskAuthTests.swift`, `IT/Data/KioskPrefsTests.swift`, `IT/Data/HeartbeatTests.swift`

**Interfaces:**
- Produces the Codable models in `Core/Model/Biometric.swift`. Each has snake_case `CodingKeys`, as in `Session.swift`.
  - `struct BiometricSerialIn { let serial: String }`
  - `struct BiometricEnrollChallengeOut { let nonce: String }`
  - `struct BiometricIosEnrollIn { serial, nonce: String; platform: String = "ios"; publicKey, appAttestKeyId, attestation, signature: String }`. All values are standard base64. The wire names are `public_key`, `app_attest_key_id`, `attestation` and `signature`.
  - `struct BiometricEnrollOut { keyId: String; securityLevel: String; renewsAt: String }`
  - `struct BiometricChallengeOut { keyId, challenge, displayName: String; photoUrl: String?; expired: Bool }`. A missing `expired` decodes as false.
  - `struct BiometricSignInIn { keyId, challenge, signature: String }`
  - `struct BiometricEnrollment: Codable, Equatable { keyId: String; personId: String; email: String? }`
- Produces these `KioskApi` members:
  - `biometricEnrollChallenge(serial: String) async throws -> String`. Authed, POST `/kiosk/biometric/enroll-challenge`.
  - `biometricEnroll(_ body: BiometricIosEnrollIn) async throws -> BiometricEnrollOut`. Authed, POST `/kiosk/biometric/enroll`.
  - `biometricChallenge(serial: String) async throws -> BiometricChallengeOut`. Plain, POST `/kiosk/biometric/challenge`.
  - `biometricSignIn(keyId: String, challenge: String, signature: String) async throws -> SessionData`. Plain, POST `/kiosk/biometric/sign-in`, and the session is stored through `signedIn`.
  - `biometricForget(serial: String) async throws`. Authed, `DELETE /kiosk/biometric?serial=`, checking a 2xx status without parsing.

  Each has a doc comment listing its error codes, taken from the Android `KioskApi.kt` docs.
- Produces in `KioskAuth`:
  - `enum LoginMethod { case password, link, biometric }`
  - `struct CurrentSignIn: Equatable { let method: LoginMethod; let email: String? }`
  - `private(set) var currentSignIn: CurrentSignIn?`
  - `func signInWithBiometric(_ data: SessionData)`
- Produces in `KioskPrefs`: `var biometric: BiometricEnrollment?`, stored under key `"ss.kiosk.biometric"` and JSON-encoded. Undecodable JSON reads as nil.

- [ ] **Step 1: Write the failing tests.** API tests use `ApiHarness` and `StubServer`, following the pattern in `IT/RolodexApiTests.swift`.

  | Test | Expected |
  |---|---|
  | `enrollChallengeIsAuthedAndReturnsTheNonce` | POST to the right path with `Authorization == "Bearer tok1"`; body `{"serial":"s1"}`; returns the nonce |
  | `enrollSendsTheIosBody` | `bodyString == #"{"app_attest_key_id":"k","attestation":"a","nonce":"n","platform":"ios","public_key":"p","serial":"s1","signature":"g"}"#` (sorted keys) |
  | `enrollRefusalKeepsTheReason` | a 422 `{"detail":{"code":"attestation_failed","reason":"environment"}}` gives `ApiError.code == "attestation_failed"` and `detail["reason"] == "environment"` |
  | `aStaleEnrollNonceNeverSignsOut` | a 422 `bad_enroll_nonce` throws, with no refresh call and no session ended |
  | `challengeNeedsNoSession` | no `Authorization` header; decodes every field; a missing `expired` gives false |
  | `signInStoresTheSessionLikeLogin` | the cookie is captured and `sessionStore` holds token `tok1` |
  | `signInErrorsCarryTheirCode` | a 403 `biometric_expired` gives `code == "biometric_expired"` |
  | `forgetDeletesWithTheSerialInTheQuery` | method DELETE, path `/kiosk/biometric?serial=s1`, and a 204 returns without throwing |

  Tests in `KioskAuthTests`:
  - `loginRecordsCurrentSignInWithTheTypedEmail`
  - `moveLoginLeavesNoCurrentSignIn` (`lastSignIn` stays `.password` for the heartbeat)
  - `pairLeavesNoCurrentSignIn`
  - `restoreLeavesNoCurrentSignIn`
  - `logoutAndEndSessionClearCurrentSignIn`
  - `signInWithBiometricMarksABiometricSignIn`: `takePendingSignIn() == .biometric`, `currentSignIn?.method == .biometric`, and the state is `.authed`

  Tests elsewhere:
  - `KioskPrefsTests`: `biometricEnrollmentRoundTripsAndNilRemoves`.
  - `HeartbeatTests`: `biometricSignInSendsBiometricLoginMethod` (`heartbeats[0].loginMethod == "biometric"`).

- [ ] **Step 2: Run the tests to verify they fail.** Use the iOS test command. Expected: a compile failure on the missing members.

- [ ] **Step 3: Implement.**
  - Add the five members to `FakeKioskApi`, following its closure, `record(name)` and `unset` pattern. The names to record are `bioEnrollChallenge`, `bioEnroll`, `bioChallenge`, `bioSignIn` and `bioForget`.
  - `bioChallengeResult` defaults to throwing `ApiError(status: 404, code: "no_biometric")`, as on Android.
  - Capture `bioEnrollBodies`.
  - Update the stale comment at `KioskAuth.swift:70`.

- [ ] **Step 4: Run the tests to verify they pass.** Use the iOS test command. Expected: all pass.

- [ ] **Step 5: Commit.**
  - `git commit -m "feat(ios): biometric sign-in API calls, models, current sign-in and prefs"`

---

### Task 4: iOS Secure Enclave keys, App Attest, prompter and project setup

**Files:**
- Create: `IK/Data/Auth/BiometricKeys.swift` (the protocol and types, plus `SecureEnclaveBiometricKeys`)
- Create: `IK/Data/Auth/BiometricPrompting.swift` (the protocol and the problem mapping, plus `SystemBiometricPrompter`)
- Create: `IK/Data/Auth/BiometricDeviceWords.swift`
- Modify: `IK/Info.plist` (`NSFaceIDUsageDescription` = "Signs you in with Face ID on an iPad or iPhone assigned to you.")
- Create: `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk.entitlements`. It sits beside the `.xcodeproj`, outside the synchronized app folder.
- Modify: `ServerSherpa Kiosk.xcodeproj/project.pbxproj`. Add `CODE_SIGN_ENTITLEMENTS = "ServerSherpa Kiosk.entitlements";` to both app build configurations (`5A3B358B3059CBEC00D542EA` Debug and `5A3B358C3059CBEC00D542EA` Release).
- Create: `IT/Support/FakeBiometricKeys.swift`, `IT/Support/FakeBiometricPrompter.swift`, `IT/Data/BiometricKeysTests.swift`

**Interfaces** (all `Sendable`):
- Types:
  - `enum BiometryKind: Equatable { case faceID, touchID }`
  - `enum BiometricReadiness: Equatable { case ready(BiometryKind), noPasscode, noneEnrolled, unsupported }`. `unsupported` covers no hardware, no App Attest, and the Simulator.
  - `enum KeyProbe: Equatable { case ready, gone, unavailable }`
  - `struct BiometricEnrollProof: Equatable { let publicKey: Data; let appAttestKeyId: String; let attestation: Data }`. `publicKey` is the 65-byte X9.63 point. `appAttestKeyId` is the base64 string `DCAppAttestService` returns.
  - `struct BiometricAuth: @unchecked Sendable { let context: LAContext }`
- The `BiometricKeys` protocol:
  - `func readiness() -> BiometricReadiness`
  - `func create(nonce: String) async throws -> BiometricEnrollProof`
  - `func probe() -> KeyProbe`
  - `func sign(_ message: Data, with auth: BiometricAuth) throws -> Data`. It returns a DER ECDSA SHA-256 signature.
  - `func delete()`
- `func biometricClientDataHash(nonce: String, publicKey: Data) -> Data`, as a free function in `BiometricKeys.swift` using CryptoKit SHA256.
- Prompting:
  - `enum BiometricPromptProblem: Error, Equatable { case lockedOut, unavailable }`
  - `protocol BiometricPrompter: Sendable { func authenticate(reason: String) async throws -> BiometricAuth? }`. It returns nil on a cancel or fallback.
  - `func biometricPromptProblem(for code: LAError.Code) -> BiometricPromptProblem?`, a pure function. `.biometryLockout` maps to `.lockedOut`. `.biometryNotAvailable` and `.biometryNotEnrolled` map to `.unavailable`. Everything else maps to nil, meaning a cancel.
- `struct BiometricWords: Equatable { let bio: String; let device: String }` is defined in Task 5 under `Core`. This task produces `@MainActor func currentBiometricWords(_ kind: BiometryKind?) -> BiometricWords`.
  - `bio`: `.faceID` gives "Face ID" and `.touchID` gives "Touch ID". With nil, use "Face ID" when the device has no Home button (`UIDevice` idiom plus a key window's bottom safe-area inset above 0) and "Touch ID" otherwise.
  - `device`: "iPad" for the `.pad` idiom, else "iPhone".
- Fakes in IT:
  - `FakeBiometricKeys` uses a CryptoKit `P256.Signing.PrivateKey` and returns `derRepresentation` signatures. Its knobs are `readinessValue`, `invalidated` (probe gives `.gone`), `probeUnavailable`, `createError`, `signError`, `created: [String]` (the nonces) and `deleted: Int`.
  - `FakeBiometricPrompter` has `answer: BiometricAuth?`, `error: Error?`, `reasons: [String]` and an optional gate to hold the prompt open.

- [ ] **Step 1: Write the failing tests in `IT/Data/BiometricKeysTests.swift`.**

  | Test | Expected |
  |---|---|
  | `clientDataHashMatchesTheServerVector` | `biometricClientDataHash(nonce: "enroll-nonce", publicKey: Data([4] + (1...64)))` hex equals `e66ae6444b04ccdff839a7a0d5041d2bf2b1797a3ffdcddfd7e59fd5828df43a` |
  | `lockoutIsLockedOut` | `biometricPromptProblem(for: .biometryLockout) == .lockedOut` |
  | `unusableSensorIsUnavailable` | `.biometryNotAvailable` and `.biometryNotEnrolled` give `.unavailable` |
  | `cancelAndFallbackAreNotProblems` | `.userCancel`, `.appCancel`, `.systemCancel`, `.userFallback` and `.authenticationFailed` give nil |
  | `fakeSignatureVerifies` | a `FakeBiometricKeys` signature over "abc" verifies with `P256.Signing.ECDSASignature(derRepresentation:)` against its public key |
  | `wordsForKinds` | `currentBiometricWords(.touchID).bio == "Touch ID"`; on the iPad simulator, `.device == "iPad"` |

- [ ] **Step 2: Run the tests to verify they fail.** Use the iOS test command. Expected: a compile failure.

- [ ] **Step 3: Implement.**
  - **`SecureEnclaveBiometricKeys`**, with application tag `"com.serversherpa.kiosk.biometric"`.
    - **readiness.**
      - `LAContext().canEvaluatePolicy(.deviceOwnerAuthentication)` failing with `.passcodeNotSet` gives `.noPasscode`.
      - `.deviceOwnerAuthenticationWithBiometrics` failing with `.biometryNotEnrolled` gives `.noneEnrolled`.
      - Any other failure, `!DCAppAttestService.shared.isSupported`, or the Simulator gives `.unsupported`.
      - Otherwise `.ready(kind)`, taken from `biometryType`.
    - **create.**
      1. `delete()`.
      2. Make `SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], nil)`.
      3. `SecKeyCreateRandomKey` with `kSecAttrKeyTypeECSECPrimeRandom`, 256 bits, `kSecAttrTokenIDSecureEnclave`, and private attributes permanent, tag and access control.
      4. Take the public key from `SecKeyCopyExternalRepresentation(SecKeyCopyPublicKey(key))`.
      5. Call `DCAppAttestService.shared.generateKey()`, then `attestKey(keyId, clientDataHash: biometricClientDataHash(nonce:publicKey:))`.
      6. If anything throws, call `delete()` and rethrow.
    - **probe.**
      - `SecItemCopyMatching` for the tag, with `kSecReturnRef` and `kSecUseAuthenticationContext` set to a context whose `interactionNotAllowed = true`.
      - `errSecSuccess` and `errSecInteractionNotAllowed` give `.ready`.
      - `errSecItemNotFound` gives `.gone`.
      - Anything else gives `.unavailable`.
    - **sign.** Look up the key with `kSecUseAuthenticationContext: auth.context`, then call `SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, message)`. A missing key throws.
    - **delete.** `SecItemDelete` for the tag, ignoring errors.
  - **`SystemBiometricPrompter`.**
    - Create a fresh `LAContext` with `localizedFallbackTitle = ""`, then call `evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)`.
    - Success returns `BiometricAuth(context:)`.
    - An `LAError` maps through `biometricPromptProblem`: a problem throws it, and nil returns nil.
  - **Entitlements file.** A plist dict holding `com.apple.developer.devicecheck.appattest-environment` = `production`.

- [ ] **Step 4: Verify.**
  - Run the iOS test command and the simulator build command. Expected: all pass.
  - Run a device build that proves signing accepts the entitlement: `xcodebuild build -scheme "ServerSherpa Kiosk" -destination 'generic/platform=iOS' -derivedDataPath ../.derived-iosbio-device -allowProvisioningUpdates -allowProvisioningDeviceRegistration`. Expected: `BUILD SUCCEEDED`.
  - If signing refuses the App Attest capability, record the exact error in the report. Do not change the entitlement value.

- [ ] **Step 5: Commit.**
  - `git commit -m "feat(ios): Secure Enclave biometric key, App Attest and Face ID prompt"`

---

### Task 5: iOS BiometricSignIn rules and copy

**Files:**
- Create: `IK/Core/Auth/BiometricCopy.swift`
- Create: `IK/Data/Auth/BiometricSignIn.swift`
- Create: `IT/Core/BiometricCopyTests.swift` and `IT/Data/BiometricSignInTests.swift`

**Interfaces:**
- Consumes:
  - Task 3: the API members, `KioskAuth.currentSignIn`, `signInWithBiometric`, `KioskPrefs.biometric` and the models.
  - Task 4: `BiometricKeys`, `BiometricPrompter`, `BiometricPromptProblem`, `BiometricReadiness`, `KeyProbe` and `BiometricAuth`.
- Produces in Core: `struct BiometricWords: Equatable, Sendable { let bio: String; let device: String }` and `enum BiometricCopy`. `BiometricCopy` has one static function per row of the spec's Copy (iOS) table. Each takes `_ w: BiometricWords`, plus `name` where the row needs it. The names are:
  - `unsupported`, `expired`, `passwordChange`, `rateLimited`, `removed`, `kioskNotAllowed`
  - `accountDisabled`, `network`, `tryAgain`, `enrollWindow`, `enrollFailed`, `enrollRetry`
  - `somethingWrong`, `lockoutCard`, `unavailableCard`, `lockoutSheet`, `unavailableSheet`
  - `signInReason(name:)`, `signInReasonFallback`, `enrollReason`
  - `rowTitle`, `rowDetail`, `rowOn`, `rowForget`, `rowOff`, `rowNotYours`
  - `forgotten`, `forgottenHereOnly`, `forgetFailed`
  - `offerOverline`, `offerTitle`, `offerBody`
- Produces in Data:
  - `struct BiometricCard: Equatable { keyId, challenge, displayName: String; photoUrl: String?; expired: Bool; email: String? }`
  - `enum NotAllowedReason { case removed, kioskNotAllowed, accountDisabled }`
  - `enum BiometricOutcome: Equatable { case signedIn, expired, passwordChange, notAllowed(String, NotAllowedReason), invalidated, canceled, failed(String) }`
  - `enum EnrollOutcome: Equatable { case enrolled, canceled, unsupported, failed(String) }`
  - The class:

    ```swift
    @MainActor @Observable final class BiometricSignIn {
        init(api: KioskApi, auth: KioskAuth, keys: BiometricKeys, prefs: KioskPrefs, identity: Identity,
             sharedStation: @escaping @MainActor () -> Bool,
             words: @escaping @MainActor (BiometryKind?) -> BiometricWords = currentBiometricWords)
        var enrollment: BiometricEnrollment? { get }   // prefs.biometric
        var words: BiometricWords { get }              // from keys.readiness()
        func offerEnroll() async -> Bool               // never throws
        func enroll(_ prompt: BiometricPrompter) async -> EnrollOutcome
        func card() async -> BiometricCard?            // never throws
        func signIn(_ prompt: BiometricPrompter, name: String?) async -> BiometricOutcome
        func forget(signedIn: Bool) async -> Bool
    }
    ```

- [ ] **Step 1: Write the failing tests.**
  - **`BiometricCopyTests`.** `faceIDOnIPadCopy` asserts every function's text for `BiometricWords(bio: "Face ID", device: "iPad")` against the spec table, verbatim. `touchIDOnIPhoneCopy` covers `unsupported`, `removed` and `forgotten`, for example "This iPhone can't use Touch ID sign-in.".
  - **`BiometricSignInTests`.** Port Android's `BiometricSignInTest` with the harness `FakeKioskApi`, `FakeBiometricKeys`, `FakeBiometricPrompter`, `KioskPrefs(freshDefaults())`, `Identity` and `KioskAuth`. The behavior of each case is in the recon `android.md` §3; the iOS differences are noted inline.

    | Test | Expected |
    |---|---|
    | `enrollSendsTheIosBodyAndStoresTheKeyId` | the body's `public_key`, `app_attest_key_id` and `attestation` are base64 of the fake proof. `signature` verifies over the nonce. Prefs hold `{keyId, personId, email}`, with the typed email. |
    | `enrollTakesAFreshNonceAndProvesTheKeyBehindThePrompt` | after `offerEnroll`, the calls are `["login", "bioEnrollChallenge", "bioEnrollChallenge", "bioEnroll"]`, with one prompt whose reason is `BiometricCopy.enrollReason` |
    | `canceledEnrollPromptLeavesNoKey` | `.canceled`; `deleted > 0`; prefs nil |
    | `attestationRefusedIsUnsupportedAndLeavesNoKey` | |
    | `enrollOtherFailuresAreFailedWithAMessage` | `enroll_window_closed` maps to `enrollWindow`, `bad_enroll_nonce` to `enrollRetry`, `network` to `network`, and anything else to `enrollFailed` |
    | `enrollWhereTheKeyStoreFailsIsUnsupported` | |
    | `moveOrPairSignInNeverOffers` | |
    | `onlyAFreshPasswordSignInIsOffered` | |
    | `timeClockAndStationKeyDevicesNeverOfferOrShowTheCard` | |
    | `offerNeedsABiometricReady` | `noPasscode`, `noneEnrolled` and `unsupported` give false |
    | `offerAsksTheServerWhetherThisDeviceIsPersonal` | |
    | `aLiveKeyIsNotOfferedAgainButADeadOneIs` | |
    | `anotherPersonsPasswordSignInLeavesTheOwnersKey` | |
    | `noOfferWhileThePasswordMustChange` | |
    | `cardNilWithoutLocalKey` | |
    | `cardCarriesTheServersNameAndTheLocalEmail` | |
    | `cardGoneOnTheServerForgetsTheLocalKey` | |
    | `cardForAnotherKeyForgetsTheLocalKey` | |
    | `cardOfflineOrThrottledKeepsTheKey` | |
    | `signInSignsTheChallengeBytes` | |
    | `thePromptComesBeforeTheChallenge` | no API calls while the prompt is held; then `["bioChallenge", "bioSignIn"]`; the prompt reason is "Sign in as Ada Lovelace" |
    | `eachSignInFetchesItsOwnChallenge` | |
    | `expiredMapsToExpired` | |
    | `passwordChangeMapsToPasswordChange` | |
    | `notAllowedMaps` | |
    | `aDisabledAccountForgetsLocallySoTheCardStopsComingBack` | |
    | `reassignedOrRevokedForgetsLocallyAndFallsBack` | |
    | `invalidatedKeyIsDeletedLocallyAndFallsBack` | |
    | `canceledPromptStaysOnCard` | |
    | `rateLimitedIsFailedWithAFriendlyMessage` | |
    | `aSpentChallengeOrBadSignatureIsFailedAndKeepsTheKey` | |
    | `forgetSignedOutDeletesLocallyOnly` | |
    | `forgetSignedInCallsServer` | |
    | `forgetSignedInOfflineStillForgetsOnTheDevice` | |
    | `aThrowingKeyStoreIsUnusableThisTimeAndKeepsTheKey` | probe `.unavailable` means no card, sign-in gives `.failed(tryAgain)`, and the enrollment and key are kept |
    | `aSecondEnrollWhileOneRunsIsCanceled` | |
    | `aSecondSignInWhileThePromptIsUpIsCanceled` | |
    | `anUndecodableAnswerIsSomethingWentWrongNotTheNetwork` | |
    | `aThrowingPromptIsTryAgainAndKeepsTheKey` | a prompter that throws during sign-in gives `.failed(BiometricCopy.tryAgain(w))` and keeps the enrollment. During enroll, a throw gives `.failed(enrollFailed)` and leaves no key. The UI's `problemAware` wrapper (Task 6) turns lockout and unavailable into nil before the rules see them, as on Android. |

- [ ] **Step 2: Run the tests to verify they fail.** Use the iOS test command. Expected: a compile failure.

- [ ] **Step 3: Implement `BiometricSignIn`.**
  - **Order and error maps.** Port them from Android `BiometricSignIn.kt`, following recon `android.md` §3: offer steps 1–5, enroll steps 1–10, card, and sign-in steps 1–8.
  - **Enroll differences from Android.**
    - `keys.create(nonce:)` returns the proof.
    - Then prompt once with `enrollReason`.
    - Then `keys.sign(Data(nonce.utf8), with: auth)` makes the proof signature, which is sent.
    - Then `api.biometricEnroll(BiometricIosEnrollIn(...))`.
    - On any failure, a `defer` or `do/catch` calls `dropLocal()`.
  - **Single flight.** A `private var busy = false`. Enroll and sign-in return `.canceled` while it is set. `forget` waits until it clears, by polling with `Task.yield()` or holding a continuation; that choice is the builder's.
  - **Eligible session.** Authed, `kioskMove == nil`, `currentSignIn?.method == .password` and `!mustChangePassword`.
  - **The email** comes from `auth.currentSignIn?.email ?? session.person.email`.

- [ ] **Step 4: Run the tests to verify they pass.** Use the iOS test command. Expected: all pass.

- [ ] **Step 5: Commit.**
  - `git commit -m "feat(ios): biometric sign-in rules and Face ID / Touch ID copy"`

---

### Task 6: iOS login card, enroll offer, This Kiosk row, wiring and docs

**Files:**
- Modify: `IK/UI/Screens/Login/LoginViewModel.swift`, `LoginForm.swift` and `LoginScreen.swift`
- Create: `IK/UI/Screens/Login/BiometricCardView.swift`
- Create: `IK/UI/Screens/Login/EnrollOffer.swift`, holding the controller and the sheet view
- Modify: `IK/UI/RootView.swift` (host the sheet)
- Create: `IK/UI/Screens/Settings/BiometricRow.swift`
- Modify: `IK/UI/Screens/Settings/ThisKioskPanel.swift`, inserting the row between Device model (L68) and API URL (L69)
- Modify: `IK/App/AppContainer.swift`
- Modify: `IOS_Kiosk_App/README.md` (a "Sign-in" section describing Face ID and Touch ID sign-in and its device-only parts)
- Create: `IT/UI/BiometricLoginTests.swift` and `IT/UI/EnrollOfferTests.swift`
- Modify: `IT/Data/AppContainerTests.swift`

**Interfaces:**
- Consumes (Task 5): `BiometricSignIn`, its outcome types and `BiometricCopy`; (Task 4): `BiometricPrompter`, `SystemBiometricPrompter` and `BiometricPromptProblem`.
- Produces:
  - **`LoginView`** gains `.biometric`.
  - **`LoginViewModel`**:
    - init adds `biometric: BiometricSignIn? = nil` and `enrollOffer: EnrollOffer? = nil`;
    - published `card: BiometricCard?`, `cardPending: Bool`, `bioBusy: Bool`, `bioError: String?`, `notice: String?`, `noticeError: Bool`;
    - `func loadCard() async`;
    - `func autoPrompt(_ p: BiometricPrompter) async`, which runs once per view model and never for an expired card;
    - `func signInWithBiometric(_ p: BiometricPrompter) async`;
    - `func usePassword()`, which shows the password form with the card's email;
    - `func otherAccount()`, which shows the empty password form;
    - `static let cardPendingMax: Duration = .seconds(3)`.
  - **`EnrollOffer`** is `@MainActor @Observable`, with `init(biometric: BiometricSignIn, auth: KioskAuth)`. It has:
    - `var sheet: EnrollOfferUI?`, where `struct EnrollOfferUI: Equatable { var busy = false; var message: String? }`;
    - `func afterPasswordSignIn()`;
    - `func notNow()`;
    - `func turnOn(_ p: BiometricPrompter) async`.

    It closes itself when `auth.state` leaves `.authed`, either by observing it or through `AppContainer`'s `onLogout`/`onSessionEnded` hooks.
  - **`AppContainer`**:
    - init adds `biometricKeys: (any BiometricKeys)? = nil`, defaulting to `SecureEnclaveBiometricKeys()`;
    - adds members `biometric` and `enrollOffer`, both injected through `appContainer(_:)`;
    - `sharedStation` is `{ prefs.setupSelection?.stationType != nil || station.hasKey }`.

- [ ] **Step 1: Write the failing tests.**
  - **`BiometricLoginTests`** is a view-model port of Android `BiometricLoginTest`. Use the harness from `LoginViewModelTests`, plus `FakeBiometricKeys` and `FakeBiometricPrompter`.

    | Test | Expected |
    |---|---|
    | `cardShowsNameAndOtherAccount` | `view == .biometric`; the card's `displayName` is from the challenge |
    | `faceIDSignsInAndGoesHome` | `auth.state` is `.authed` |
    | `theAutoPromptRunsOnce` | two `autoPrompt` calls give `prompter.reasons.count == 1` |
    | `lockoutHasItsOwnMessageAndStaysOnTheCard` | `bioError == BiometricCopy.lockoutCard(w)` |
    | `anUnavailableSensorSaysSoAndStaysOnTheCard` | |
    | `usePasswordShowsThePasswordFormWithTheEmail` | |
    | `otherAccountShowsTheEmptyPasswordForm` | |
    | `expiredShowsPrefilledEmailAndLine` | `notice == BiometricCopy.expired(w)`; no prompt |
    | `passwordChangeShowsPortalMessage` | |
    | `reassignedFallsBackToPasswordWithMessageAndNoEmail` | |
    | `kioskAccessRemovedKeepsTheEmail` | |
    | `aDisabledAccountFallsBackToPasswordWithMessage` | |
    | `rateLimitedStaysOnTheCardWithItsMessage` | |
    | `aNetworkFailureStaysOnTheCardWithItsMessage` | |
    | `aKeyDroppedAfterTheCardShowedIsThePlainForm` | |
    | `checkingShowsWhileTheCardIsOnItsWayThenTheCard` | |
    | `offlineEndsOnTheForm` | |
    | `aKeyGoneBeforeTheCardNeverPrefills` | |
    | `checkingGivesUpAfterThreeSeconds` | uses an injectable sleep or clock |
    | `aLateCardNeverReplacesAStartedForm` | typing an email while `loadCard` is held means the card never replaces the form |
    | `usePasswordWhileCheckingOpensAnEmptyFormThatALateCardNeverReplaces` | |
    | `noKeyOnTheDeviceIsThePlainPasswordForm` | |
    | `noCardForATimeClockStationOrWhileSignedIn` | |
    | `passwordSignInStartsTheOfferInTheBackground` | `submit()` returns before the offer decides, and `enrollOffer.sheet` appears afterward |

  - **`EnrollOfferTests`**:

    | Test | Expected |
    |---|---|
    | `offerAfterPasswordSignInOnPersonalDevice` | |
    | `notNowAsksAgainNextPasswordSignIn` | |
    | `noOfferWhenSignedOutBeforeTheAnswer` | |
    | `noOfferWhenSomeoneElseIsSignedInByTheAnswer` | |
    | `signingOutClosesTheSheet` | |
    | `noOfferWithoutABiometricInIOS` | |
    | `noOfferAfterAMovePasswordOrOnATimeClockStation` | |
    | `attestationRefusedSaysThisDeviceCantUseIt` | `message == BiometricCopy.unsupported(w)` |
    | `aCanceledPromptKeepsTheSheetWithNoMessage` | |
    | `lockoutDuringTurnOnHasItsOwnMessage` | `lockoutSheet` |
    | `anUnavailableSensorDuringTurnOnSaysSo` | |
    | `signingOutDuringTurnOnStopsItAndTheSheetStaysClosed` | hold the prompt, sign out, release it: `sheet == nil` and `prefs.biometric == nil` |

  - **Row logic.** Make it a pure function in `BiometricRow.swift`: `func biometricRowState(enrollment: BiometricEnrollment?, signedInPersonId: String?) -> BiometricRowState`, with `enum BiometricRowState { case off, notYours, on }`. Test it in `BiometricLoginTests`:
    - `rowIsOffWithoutEnrollment`
    - `rowIsNotYoursForSomeoneElseSignedIn`
    - `rowIsOnForTheOwnerOrSignedOut`
  - **`AppContainerTests`**:
    - `biometricIsWiredWithTheSharedStationRule`: a time-clock `setupSelection` means `offerEnroll() == false`.
    - `resetAppKeepsTheBiometricEnrollment`.
    - `signOutKeepsTheBiometricEnrollment` (`auth.logout()` leaves `prefs.biometric` and the key intact).

- [ ] **Step 2: Run the tests to verify they fail.** Use the iOS test command. Expected: a compile failure.

- [ ] **Step 3: Implement.**
  - **The card** (`BiometricCardView`) matches the login form's look, using the existing `LoginSubmitButton` and `LoginQuietLink` components.
    - An 88-pt round avatar: the photo through `api.fetchImage` plus `RolodexAvatar.downsample`, with initials from `initialsOf` until it loads.
    - A primary button "Sign in as <name>" with a `faceid` or `touchid` SF Symbol, and a spinner while `bioBusy`.
    - A red `bioError` line.
    - "Use password" and "Other account" links.
    - The pending state shows an empty circle, "Checking…" and "Use password".
  - **`LoginForm`.**
    - `switch vm.view` gains `case .biometric`.
    - A `LoginErrorText`-styled `notice` line appears above the password fields. It is red when `noticeError` and neutral otherwise.
  - **`LoginScreen`.** In `.task`, call `loadBanners`/`loadStatus`, then `await vm.loadCard()`. `.task(id: vm.view)` calls `await vm.autoPrompt(prompter)`, with `prompter = SystemBiometricPrompter()`.
  - **The enroll sheet** is presented from `RootView` with `.sheet(item:)` over the signed-in app.
    - It shows the overline, title and body from `BiometricCopy`, then "Turn on" ("Turning on…" while busy, disabled), then "Not now".
    - It uses rounded corners and follows the theme. Do not force light: Jimmy's rule is that every screen follows light and dark.
  - **The row** shows the "Biometric sign-in" title and detail, then:
    - off: the off text;
    - not yours: the not-yours text;
    - on: "<Bio> sign-in: On ·" plus a `LinkButton` "Forget this device".

    Forget calls `biometric.forget(signedIn: auth.state is .authed)` and shows the result in a `KioskToast`, choosing `forgotten`, `forgottenHereOnly` or `forgetFailed`.
  - **`problemAware`.** Wrap the prompter so a thrown `BiometricPromptProblem` becomes nil, meaning a cancel, while recording the problem for the line under the card or in the sheet.

- [ ] **Step 4: Verify.**
  - Run the iOS test command and the simulator build. Expected: all pass, with no regressions in `LoginViewModelTests`.
  - Launch the app on the iPad simulator. Confirm the login screen still shows the password form, because the Simulator is `unsupported` and so shows no card and no offer.
  - Take a screenshot to the scratchpad.

- [ ] **Step 5: Commit.**
  - `git commit -m "feat(ios): Face ID sign-in card, enroll offer and This Kiosk row"`
