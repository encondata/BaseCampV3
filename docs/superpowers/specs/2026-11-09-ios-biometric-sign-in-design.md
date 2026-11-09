# Kiosk biometric sign-in (iOS): design

Date: 2026-11-09 · Owner: Jimmy Henderson · Status: approved ("write and build")

Ports Android biometric sign-in to the iOS kiosk app (iPad and iPhone). The Android design is the base: `docs/superpowers/specs/2026-10-23-kiosk-biometric-sign-in-design.md` and its implementation notes. Everything in it holds for iOS unless this document says otherwise:
- Personal devices only.
- The 30-day rule.
- Two-factor is satisfied.
- Forget.
- Every automatic revoke.
- Shared stations.
- Read-only freeze.
- Rate limits.
- Audit.

## Intent

The person a kiosk iPad or iPhone is assigned to should sign in with Face ID or Touch ID instead of typing a password every day, as on Android.

## Jimmy's decisions

1. **Same feature as Android.** It uses the same server routes, the same "Personal device of" assignment in the portal, the same 30 days from the last password sign-in, and the same Forget and revocation rules.
2. **App Attest is the proof** (2026-11-09: "if app attest is a valid level of proof than i am fine with it").
   - Apple has no proof for a single key the way Android's key attestation does.
   - At enrollment, the server instead checks Apple's App Attest statement. It proves the request comes from our genuine, unmodified app (team `Y2QYBG96U4`, bundle `Server-Sherpas.ServerSherpa-Kiosk`) on a real Apple device.
   - The statement is bound to the sign-in key's public key. That key is created by that genuine app in the Secure Enclave, behind Face ID or Touch ID.
   - The server trusts the app's code for the "needs Face ID" part. It does not check that part directly.

## What the person sees

The copy names the device's own biometric: **Face ID** or **Touch ID** (from `LAContext.biometryType`). It also names the device: **iPad** or **iPhone** (from the interface idiom). Below, `<Bio>` and `<device>` stand for those words.

- **Offer.** After an email-and-password sign-in on the device assigned to them, a sheet appears over the signed-in app.
  - Overline "SIGN-IN", title "<Bio> sign-in".
  - Body: "Use <Bio> to sign in on this <device>? You'll sign in with your password again every 30 days."
  - Buttons **Turn on** ("Turning on…" while busy) and **Not now**.
  - Turn on runs the system <Bio> prompt once. Not now stores nothing, so the next password sign-in asks again.
- **Card.** The sign-in screen opens on a card:
  - the person's photo, or their initials;
  - a primary button **Sign in as <name>** with the `faceid` or `touchid` symbol;
  - **Use password**, which opens the password form with their email filled in;
  - **Other account**, which opens the empty password form. iOS has no chooser; its password view already carries "Pair with phone" and "Use a move password".

  The <Bio> prompt starts on its own, once per screen.
- **Checking.** While the card is loading, the screen shows "Checking…" with **Use password**, for at most 3 s. A card that arrives late never replaces a form the person has started.
- **Expired** after 30 days: the password form with the email filled in and the line "Sign in with your password to keep using <Bio>."
- **Biometric only.** No passcode fallback: the system prompt shows no "Enter Passcode" button. Adding a face or finger, or removing the passcode, kills the key. The app then falls back to the plain password form, and the next password sign-in offers again.
- **Settings › This Kiosk.** A row titled "Biometric sign-in", with the detail "Sign in with Face ID or Touch ID on an iPad or iPhone assigned to you." It has three states, as on Android:
  - Off;
  - on for another person;
  - "<Bio> sign-in: On · Forget this device".

  It works signed out too. Signed out, Forget deletes the key on the device only.
- **Kept or never offered.** Sign out, Reset app and Kiosk Setup keep the key. Nothing is offered or shown:
  - on a Time Clock station or a device holding a station key;
  - after a move-password sign-in or a link (pair) sign-in;
  - on a move-locked session;
  - while the password must change.

### Copy (iOS)

| Constant | Text |
|---|---|
| unsupported | "This <device> can't use <Bio> sign-in." |
| expired | "Sign in with your password to keep using <Bio>." |
| password change | "Your password needs changing in the portal." |
| rate limited | "Too many sign-in tries. Wait a few minutes, then try again." |
| removed | "<Bio> sign-in is off for this <device>. Sign in with your password." |
| kiosk not allowed | "This account isn't allowed to use kiosks. Ask your coordinator to grant kiosk access." |
| account disabled | "This account is disabled. Contact your coordinator." |
| network | "Can't reach the server. Check the kiosk's network connection." |
| try again | "<Bio> sign-in didn't go through. Try again, or use your password." |
| enroll window | "Sign in with your password again to turn on <Bio> sign-in." |
| enroll failed | "Couldn't turn on <Bio> sign-in. Try again later." |
| enroll retry | "Turning on <Bio> sign-in took too long. Tap Turn on to try again." |
| something wrong | "Something went wrong. Try again, or use your password." |
| lockout (card) | "Too many tries. Use your password, or try again later." |
| unavailable (card) | "<Bio> isn't available right now. Use your password." |
| lockout (sheet) | "Too many tries. Try again later." |
| unavailable (sheet) | "<Bio> isn't available right now. Try again later." |
| sign-in prompt reason | "Sign in as <name>" (fallback "Sign in to ServerSherpa") |
| enroll prompt reason | "Turn on <Bio> sign-in" |
| row on | "<Bio> sign-in: On ·" + link "Forget this device" |
| row off | "Off. After a password sign-in on an iPad or iPhone assigned to you, the app offers to turn it on." |
| row not yours | "On for another person. Only they can forget it here, or an admin in the portal." |
| forgotten | "This <device> forgot <Bio> sign-in." |
| forgotten here only | "This <device> forgot <Bio> sign-in, but the portal couldn't be reached. An admin can remove it there." |
| forget failed | "Couldn't forget <Bio> sign-in on this <device>. Try again." |
| `NSFaceIDUsageDescription` | "Signs you in with Face ID on an iPad or iPhone assigned to you." |

Where `LAContext` reports no biometry (nothing enrolled, or no sensor), `<Bio>` is "Face ID" on devices without a Home button and "Touch ID" otherwise. *Builder's call:* only rows that need a word while nothing is enrolled use this, and "Face ID or Touch ID" is an acceptable fallback.

## Server

### Enroll (the only route that changes)

`POST /kiosk/biometric/enroll` gains a platform field.

- **Android:** the body is unchanged. The default is `platform: "android"` plus `chain`.
- **iOS:** the body is `platform: "ios"` plus:
  - `serial` and `nonce`, as today;
  - `public_key`: standard base64 of the Secure Enclave key's X9.63 point, `04‖X‖Y`, exactly 65 bytes;
  - `app_attest_key_id`: standard base64 of the 32-byte App Attest key identifier;
  - `attestation`: standard base64 of the App Attest attestation object (CBOR). Cap it at about 32 KB.
  - `signature`: standard base64 of a DER ECDSA signature, by the Secure Enclave key behind the prompt, over the nonce's UTF-8 bytes (SHA256withECDSA, the same format as sign-in).

  A body that mixes or omits a platform's fields is rejected with 422 by validation.

The gate is unchanged: the same `_enrollable_device`, the 10-minute password-session window, the personal device, not shared, not a move identity, and the same `bad_enroll_nonce` and nonce-spent rules.

The iOS path differs from Android's in three ways:
- It skips the Google revocation-list gate (`attestation_status_unavailable` is Android-only).
- It verifies the App Attest statement (below), then the proof signature against `public_key`. A bad proof is 422 `attestation_failed` with reason `proof`.
- It stores the key with `security_level = "secure_enclave"` and the public key as DER SubjectPublicKeyInfo, wrapped from the X9.63 point. Sign-in then works unchanged.

The audit `biometric_enroll` changes also record `platform`.

`clientDataHash` binds the attestation to this enrollment and this key:

```
clientDataHash = SHA256( UTF-8(nonce) ‖ public_key_x963 )
```

The app passes exactly this to `DCAppAttestService.attestKey(_:clientDataHash:)`. The server recomputes it.

### App Attest verification (`security/app_attest.py`, new)

`verify_app_attest(attestation: bytes, *, key_id: bytes, client_data_hash: bytes, app_id: str, allow_development: bool, roots=None, now=None) -> None`

It runs Apple's checks ("Validating apps that connect to your server") in this order. Each failure raises `AttestationError(reason)`, which the route returns as 422 `attestation_failed{reason}`.

1. CBOR decode. `fmt == "apple-appattest"`, and `attStmt.x5c` holds the credential certificate followed by the intermediate. Otherwise `parse` or `format`.
2. Chain: credCert is issued by the intermediate, which is issued by the pinned **Apple App Attestation Root CA**. Every certificate's dates cover `now`. Otherwise `chain`, `root` or `expired`.
3. nonce = SHA256(authData ‖ clientDataHash). It must equal the single OCTET STRING inside credCert's extension OID `1.2.840.113635.100.8.2`, which is DER `SEQUENCE { [1] EXPLICIT OCTET STRING }`. Otherwise `challenge`.
4. SHA256 of credCert's public key, as the uncompressed X9.63 point, equals `key_id`. Otherwise `key_id`.
5. authData rpIdHash (bytes 0–31) equals SHA256(UTF-8(app_id)). Otherwise `app_id`.
6. sign count (bytes 33–36) is 0. Otherwise `counter`.
7. aaguid (bytes 37–52):
   - `appattest` followed by seven 0x00 bytes (production) is always accepted;
   - `appattestdevelop` (development) is accepted only when `allow_development` is set;
   - anything else is `environment`.
8. credentialId (length at bytes 53–54, then the id) equals `key_id`. Otherwise `key_id`.

Further requirements:
- **Error reasons.** `AttestationError`'s reason list grows: `format`, `key_id`, `app_id`, `counter`, `environment`, `proof`.
- **App ID.** The app ID is a constant, `KIOSK_IOS_APP_ID = "Y2QYBG96U4.Server-Sherpas.ServerSherpa-Kiosk"`, like Android's `KIOSK_PACKAGE`. Apple only attests apps signed by that team, so no setting is needed.
- **New setting.** `SS_KIOSK_APP_ATTEST_DEVELOPMENT` (bool, default false) is passed as `allow_development`. The dev `.env` sets it to true, because builds installed from Xcode or `devicectl` use Apple's development environment. App Store and TestFlight builds use production. No deploy or Sirdar plumbing is needed, since production keeps the default.
- **Apple's root.** It is pinned at `security/app_attest_roots/apple_app_attestation_root_ca.pem`, with a README giving its source URL (`https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem`) and SHA-256 fingerprint. It is added to package-data.
  - **It must not go in `attestation_roots/`.** `google_roots()` trusts every `.pem` there, and `test_pinned_google_roots` expects exactly Google's 5.
- **No receipt.** The receipt and Apple's fraud-risk metric are not used. App Attest assertions are not used either, because sign-ins are signed by the Secure Enclave key, as on Android.
- **CBOR library.** Add `cbor2` to `api/pyproject.toml`.

### Data (migration 0124)

- Widen `ck_biometric_keys_security_level` to `('tee', 'strongbox', 'secure_enclave')`.
- Downgrade deletes `secure_enclave` rows, then restores the narrower check.
- Widen the `security_level` Literals in `schemas.py` (`BiometricEnrollOut`, `BiometricKeyOut`) and the model comment. No new columns are needed.

### Unchanged

These are reused as they are:
- `enroll-challenge`, `challenge`, `sign-in` and `DELETE`;
- `signature_valid`, which takes a DER signature over the challenge's UTF-8 bytes;
- the heartbeat `login_method: "biometric"`;
- the admin, `/me` and device routes;
- every revocation.

## iOS app

Paths are under `IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/`. The layout rule still holds: `Core/` imports Foundation only. LocalAuthentication, DeviceCheck, Security and CryptoKit code goes in `Data/Auth/`.

- **Keys** (`Data/Auth/BiometricKeys.swift`): a protocol with the real implementation behind it, and a software fake in tests.
  - **Readiness.**
    - A passcode must be set.
    - A biometric must be enrolled (`canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics)`).
    - `DCAppAttestService.shared.isSupported` must be true.
    - The result also reports which biometric the device has.
  - **Create.**
    1. Delete any old key.
    2. Make a Secure Enclave P-256 key (`kSecAttrTokenIDSecureEnclave`, permanent, with an application tag). Its access control is `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` with `[.privateKeyUsage, .biometryCurrentSet]`.
    3. Generate a new App Attest key and attest it with the `clientDataHash` above.
    4. Return the X9.63 public key, the App Attest key id and the attestation object.
    5. On any failure, leave no key behind.
  - **Probe**, with no prompt (`LAContext.interactionNotAllowed = true`): ready, gone (the key is missing or invalidated) or unavailable (it threw). A throwing Keychain is "unusable this time" and is never a reason to forget the key.
  - **Sign** a message with a given authenticated `LAContext` (`kSecUseAuthenticationContext`, `.ecdsaSignatureMessageX962SHA256`), and **delete**.
- **Prompt** (`Data/Auth/BiometricPrompting.swift`): evaluates `.deviceOwnerAuthenticationWithBiometrics` on a fresh `LAContext` with `localizedFallbackTitle = ""`. Success returns that context, so the signature that follows doesn't prompt a second time.
  - Locked out (`biometryLockout`) throws "locked out".
  - `biometryNotAvailable` or `biometryNotEnrolled` throws "unavailable".
  - Any cancel or fallback returns nil.
- **Rules** (`Data/Auth/BiometricSignIn.swift`, @MainActor): a port of Android's `BiometricSignIn`.
  - The operations are offer, enroll, card, sign-in and forget, with the same order, outcomes, error-code maps and single-flight lock. The prompt comes first, then a fresh challenge, then the signature.
  - Enroll sequence:
    1. Make a fresh enroll nonce.
    2. Create the key.
    3. Prompt once.
    4. Sign the nonce.
    5. Send the iOS enroll body.
    6. Store the enrollment.
  - The proof signature is sent, not discarded as on Android.
  - **Shared station** means `prefs.setupSelection?.stationType != nil || station.hasKey`.
- **Outcomes and copy** (`Core/Auth/BiometricCopy.swift`): the pure outcome-to-copy mapping, with the biometric and device words passed in.
- **Prefs.** The enrollment `{keyId, personId, email}` is stored under `ss.kiosk.biometric`, as on Android. No name is stored; the card's name and photo come from `/challenge` each time.
- **Auth** (`KioskAuth`):
  - `LoginMethod` gains `.biometric`.
  - A `currentSignIn` (method plus the typed email) is set only by an email-and-password `login`, and by biometric sign-in as `.biometric`. A move-password sign-in, a pair sign-in, a restore, sign-out and session end leave it nil.
  - `signInWithBiometric` stores the session the way `login` does. The heartbeat then sends `login_method: "biometric"`.
- **API**: five calls added to `KioskApi`, `URLSessionKioskApi` and `FakeKioskApi`, matching Android's. Forget's 204 is checked by status, not parsed.
- **UI**:
  - `LoginView` gains `.biometric` (the card) and the "Checking…" state.
  - The offer is an app-scoped `EnrollOffer`. A successful `LoginViewModel.submit()` starts it in the background; the sign-in never waits for it. Its sheet is hosted over the signed-in app and closes on sign-out.
  - The This Kiosk row goes between Device model and API URL.
- **Project**:
  - `NSFaceIDUsageDescription` in `Info.plist`.
  - An entitlements file outside the synchronized app folder, with `com.apple.developer.devicecheck.appattest-environment = development`. `CODE_SIGN_ENTITLEMENTS` points to it in both app configurations.
  - App Store and TestFlight builds use production regardless.

## Non-goals

- Unlocking the app after it goes to the background.
- The portal web.
- The laptop kiosk.
- Android changes.
- Portal copy that says "fingerprint" or "phone", and the portal's `security_level` type in `api.ts`. Those belong to the browser session. The portal works unchanged with the new value.

## Anti-goals

- A person signing in as someone else on a device personal to another person.
- Storing a password or a reusable token.
- Biometric sign-in still working after the account is disabled, the password is reset, or the device is reassigned.
- A passcode unlocking the key instead of Face ID or Touch ID.

## Left to the builder

- How the enroll body's platform branch is modelled (a discriminated union or one model with a validator), within the field rules above.
- The keychain application tag, test names, and file splits within the folders named.
- Avatar caching for the card.

## Device checks owed

The device is Jimmy's iPad Pro 13 (Face ID), against the dev stack:
- dev DB at 0124;
- `cbor2` installed;
- `SS_KIOSK_APP_ATTEST_DEVELOPMENT=true`;
- the iPad assigned to Jimmy as a personal device in the portal.

Check:
- enroll;
- sign in;
- cancel;
- expired (by moving the anchor in the DB);
- an alternate appearance added in Settings kills the key;
- Forget in the app, on /me and on the device page;
- clearing the assignment.

Touch ID needs a Touch ID device; none is known.

**Signing risk:** automatic signing must add App Attest to the App ID. If `xcodebuild -allowProvisioningUpdates` can't, Jimmy ticks the App Attest capability once in Xcode.
