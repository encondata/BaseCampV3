# Kiosk biometric sign-in (Android): design

Date: 2026-10-23 · Owner: Jimmy Henderson · Status: draft for approval

## Intent

When the kiosk app runs on a person's own phone, that person is nearly always the only one who signs in. Typing an email and password every day is friction with no security benefit there. After one email-and-password sign-in, the app should let them sign in with a fingerprint or face. Anyone else still has the normal ways in, behind "Other account".

## Jimmy's decisions

1. **Device key, not a stored token (option B).**
   - After a password sign-in, the phone makes a key pair in Android Keystore that only a strong biometric can use.
   - The server registers the public key to that person and that device.
   - Signing in means the server sends a one-time challenge, and the phone signs it after a fingerprint or face check.
   - The phone never stores a password or a reusable token for this.
2. **Personal devices only, set by an admin in the portal (option A).**
   - On a kiosk's device page (`/hardware/kiosks/:id`), an admin sets "Personal device of: <person>".
   - Biometric sign-in is offered only to that person, on that device.
   - Removing or changing the assignment removes their biometric sign-in there.
3. **Satisfies two-factor.** A biometric sign-in passes two-factor: the key is something you have and the fingerprint is something you are. Kiosk sign-ins skip the TOTP step today anyway, so nothing changes for the kiosk. The rule is written down here so a later portal or iOS use of the same key follows it.
4. **30 days.**
   - Biometric sign-in works for 30 days after the last email-and-password sign-in on that device.
   - After that, the app asks for the email and password again, and that sign-in re-enables biometrics for another 30 days on the same key. No re-enrollment is needed.
   - The 30 days are fixed from the last password sign-in. Biometric sign-ins don't extend them.
5. **Key attestation is checked.** The server accepts a key only after Android's key attestation proves it lives in secure hardware and needs a strong biometric for every use. A modified app can't register a plain software key. See Server › Attestation.
6. **Forget this device.** The person can remove their biometric sign-in from the device. So can an admin, from the person's page or the device page.

## What the person sees (Android)

- **First time.** On their assigned device, they sign in with email and password. If the phone has a secure lock screen and a strong biometric enrolled, a sheet asks: "Use fingerprint or face to sign in on this phone? You'll sign in with your password again every 30 days." The buttons are **Turn on** and **Not now**.
  - Turn on runs the system biometric prompt once, which creates and registers the key.
  - Not now asks again at the next password sign-in.
- **Next time.** The sign-in screen opens on a **Sign in as Jimmy Henderson** card, with their photo when they have one, and the biometric prompt starts on its own. Under it is **Other account**, which opens today's choices: email and password, link with phone (the QR or code), and move password with its QR scan.
- **Expired after 30 days.** The card reads "Sign in with your password to keep using fingerprint." It shows the email field pre-filled with their email (kept on the phone since enrollment), plus the password field.
- **Cancel or a failed biometric.** They stay on the card. They can try again or tap **Use password**.
- **Forget.** In Settings › This Kiosk, a row reads "Fingerprint sign-in: On · Forget this device". Signed in, Forget deletes the key on the phone and revokes it on the server. Signed out, it deletes the key on the phone only (see Rules › Forget).
- **Sign out.** Sign out keeps the biometric option, so the next sign-in is the card.

## Server

### Data (migration 0107, chained on this branch's 0106)

- `devices.personal_person_id`: UUID, FK `people.id` ON DELETE SET NULL, nullable, with `personal_set_at` and `personal_set_by`.
- New table `biometric_keys`:

  | Column | Notes |
  |---|---|
  | `id` | |
  | `person_id` | FK `people` ON DELETE CASCADE |
  | `device_id` | FK `devices` ON DELETE CASCADE |
  | `public_key` | DER bytes: EC P-256 |
  | `key_alg` | `"ES256"` |
  | `created_at` | |
  | `password_sign_in_at` | The 30-day anchor |
  | `last_used_at` | |
  | `revoked_at`, `revoke_reason` | |

  There is a unique live key per (person_id, device_id): a partial unique index where revoked_at is null.
- `auth_sessions.login_method` (TEXT, nullable for old rows): set by `start_session` from the route that signed in (`password`, `link`, `move` or `biometric`) and carried through refresh rotation. *Builder's call:* the server must know a sign-in was a password one from its own records, never from the heartbeat's self-reported `login_method`, which a biometric session could fake to renew forever.
- Challenges: there is no new table. A short-lived signed JWT challenge (typ `bio`, 60 s, holding the key id and a random nonce) follows the TOTP challenge-token pattern in `services/totp.py`. Single use is enforced by recording the nonce's jti on the key row (`last_nonce`), since one key never runs two sign-ins at once.

### Rules

- **Enroll challenge** (`POST /kiosk/biometric/enroll-challenge`, kiosk session, same conditions as enroll): returns a single-use random nonce (signed JWT, 5 min), which the app passes to `KeyGenParameterSpec.Builder.setAttestationChallenge` when it makes the key.
- **Enroll** (`POST /kiosk/biometric/enroll`, kiosk session):
  - The body is the serial, the enroll nonce and the key's attestation certificate chain (`KeyStore.getCertificateChain`, leaf first, DER). The public key is the leaf's.
  - Allowed only for a person session whose `auth_sessions.login_method` is `password`, started in the last 10 minutes and bound to that serial (or binding it now), on a device whose `personal_person_id` is that person.
  - It upserts the person's live key on that device. Any older key there is revoked.
- **Challenge** (`POST /kiosk/biometric/challenge`, no auth): the body is the serial. It returns `{key_id, challenge, display_name, photo_url, expired}` only if the device has a live key for its personal person. Otherwise it returns 404 `no_biometric`. No email leaves this route; `expired` lets the app show the password card straight away. *Builder's call:* the name and photo already show on the device's own screen, and the serial is a random per-install id.
- **Sign in** (`POST /kiosk/biometric/sign-in`, no auth): the body is the key id, the challenge and the signature. It verifies all of these:
  - the signature against the public key;
  - the challenge (unexpired, unused);
  - the key is live;
  - the device is still personal to that person;
  - the account is usable (the same check as refresh) and holds `kiosk:view`, else 403 `kiosk_not_allowed`, as kiosk password and move sign-ins do;
  - the password hasn't expired under the password-expiry policy, else 403 `password_change_required`; the app then shows the password form with "Your password needs changing in the portal.";
  - fewer than 30 days since `password_sign_in_at`. Otherwise it returns 403 `biometric_expired`.

  It then mints `start_session(client="kiosk", audit_action="login_biometric")` and records `login_method="biometric"`.
- **Password sign-in renews.** When a session whose `login_method` is `password` binds a serial (its first `/kiosk/heartbeat`, `_bind_kiosk_session`), the person's live key on that device gets `password_sign_in_at = now()`. "Last password sign-in" has no source today: `account.last_login_at` is stamped by every sign-in type, so the anchor lives on the key.
- **Forget** (`DELETE /kiosk/biometric`, kiosk session, for the person's own key). The admin versions live on the user page (users:change) and the device page (scanning_hardware:change plus rank 80, like the page's other writes). Each revokes the key with a reason. *Builder's call:* signed out, the app's Forget, and a key Android invalidated (new fingerprint, screen lock removed), delete the key on the phone only. The server row is useless without the private key, and the next enroll or any lifecycle revoke retires it.
- **Revoked automatically** wherever sessions or trust are revoked today:
  - admin password reset;
  - self-service reset or invite completion;
  - the person changing their password;
  - disable;
  - blacklist (both paths);
  - demote (explicit delete before the account goes);
  - per-person revoke-all;
  - global revoke-all;
  - the device's personal assignment being cleared or changed;
  - the device being deleted (cascade).

  Clear Setup does not revoke the key. It's a setup reset, not an identity one.
- **Read-only freeze.** Challenge and sign-in never call the freeze check, like `/kiosk/pair*`. Forget is exempt, as self-service forgetting a trusted browser is. Enroll is frozen like any other write.
- **Rate limit.** Sign-in failures share the move-login style per-IP cap.
- **Audit.** Enroll, sign-in, forget, revoke, and personal assignment set or cleared.

### Attestation (checked at enroll, refused with 422 `attestation_failed` plus a reason code the app maps to "This phone can't use fingerprint sign-in.")

- **Chain:** every certificate verifies against the next, and the root is one of Google's hardware attestation roots, pinned in the code. Pin the published roots, including the newer ECDSA root Google added; the builder takes the current list from Google's key attestation docs. No certificate in the chain is expired.
- **Revocation:** no certificate's serial is on Google's attestation revocation list (`https://android.googleapis.com/attestation/status`). An existing worker refreshes the list daily into system config. Enroll is refused with `attestation_status_unavailable` if the cached list is more than 7 days old. Sign-ins are unaffected.
- **Key description extension** (OID 1.3.6.1.4.1.11129.2.1.17) on the leaf:
  - `attestationChallenge` equals the enroll nonce;
  - `attestationSecurityLevel` and `keyMintSecurityLevel` are TrustedEnvironment or StrongBox, never Software;
  - the hardware-enforced list has: algorithm EC, curve P-256, purpose SIGN, `userAuthType` including biometric, no `noAuthRequired`, no auth timeout (auth per use);
  - `attestationApplicationId` names package `com.serversherpa.kiosk` with a signing-certificate digest on the server's allowlist (setting `SS_KIOSK_SIGNING_DIGESTS`: release upload key, Play app-signing key, and the debug key in dev).
- **Root of trust:** `deviceLocked` is true and `verifiedBootState` is Verified. A phone with an unlocked bootloader can't enroll.
- **Stored:** the chain's leaf public key plus the security level (TEE or StrongBox) on the key row, for the portal panels. The full chain is not kept.
- **Parsing:** use `cryptography` for the X.509 chain and a pinned ASN.1 parser (`pyasn1` with the KeyDescription schema) for the extension. Pin fixtures from a real Pixel and a real Zebra handheld (MC2200) in the tests, alongside generated negative cases (software key, wrong challenge, wrong package, unlocked boot, revoked serial).

## Portal

- **Device page** (`KioskDetail.tsx`, Overview): a "Personal device" row with a person picker (the existing directory-search idiom). It shows the current person and whether they have biometric sign-in on: "Fingerprint on · renews by Nov 22". It has Clear and Forget fingerprint. Requires scanning_hardware:change plus rank 80, like the page's other writes. The picker offers only people with a login account and `kiosk:view`, never a move's hidden kiosk identity (`source == "kiosk_move"`).
- **User page:** a "Biometric sign-in" panel next to Remembered browsers. It lists their keys by device name, created, last used and renews-by, with Forget and Forget all.
- **/me:** the same panel for the person's own keys, with Forget.

## Android

- New `data/auth/BiometricSignIn.kt`:
  - It wraps the Keystore (EC P-256, `setUserAuthenticationRequired(true)`, `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)`, `setInvalidatedByBiometricEnrollment(true)`).
  - `BiometricPrompt` uses `CryptoObject(Signature)`.
  - It stores the key id in prefs.
- A key that becomes invalid (a new fingerprint enrolled, the screen lock removed) is treated as forgotten on the phone, and the app falls back to the password form. The next password sign-in offers enrollment again.
- New dependency: `androidx.biometric`.
- **Sign-in screen:**
  - The **Sign in as …** card appears when a challenge succeeds for this serial.
  - **Other account** leads to the existing chooser.
  - The expired state is the password form pre-filled with the email.
- **Settings › This Kiosk:** the row with Forget, or "Personal device of someone else / not personal" as information.
- `LoginMethod` gains `BIOMETRIC`. The server's `HeartbeatIn.login_method` gains `"biometric"`.
- Reset app keeps the key, as it keeps the sign-in. Clear Setup keeps it.
- Move-locked sessions, Time Clock stations and station-key sessions never offer biometric sign-in or show the card.

## Non-goals

- iOS: Face ID later, using the same API.
- The portal web: no WebAuthn.
- The laptop kiosk.
- Unlocking the app after it goes to the background. Sessions keep their current lifetime.

## Anti-goals

- A person signing in as someone else on a device personal to another person.
- Storing a password or a reusable token for biometric sign-in.
- A biometric sign-in still working after the account is disabled, the password is reset, or the device is reassigned.

## Left to the builder

- The attestation reason codes and their exact mapping, the revocation-list refresh worker (an existing Procfile worker), and how the pinned roots are stored.

- Exact copy wording, apart from the strings fixed above.
- The rate-limit numbers: reuse the move-login caps.
- Whether the card shows the photo.
- Error-code names beyond those named here.

## Device checks owed

- Attestation on the Pixel 10 Pro XL (StrongBox expected) and on a Zebra MC2200 (TEE expected; confirm its attestation chain reaches a Google root, since some OEM chains historically didn't). If a Zebra device fails the root check, report it to Jimmy rather than loosening the check.

- Pixel: enroll, sign in, cancel, expired.
- A new fingerprint invalidates the key.
- Removing the screen lock.
- Forget from the app, from /me and from the user page.
- Clearing the device assignment in the portal.

## Implementation notes (2026-10-24)

Built on branch `biometric-sign-in` by subagent-driven development, with per-task reviews and fix rounds.

**Rulings that changed or sharpened the design**
- **Certificate expiry.** Follows Google's attestation documentation, not the spec's literal "no certificate expired": factory-key chains under the RSA root stay trusted past expiry and root dates are unchecked. The literal rule would reject every device under the 2016 root (expired 2026-05-24). Revocation still applies.
- **Chain shape.** The factory exemption needs exactly 4 certificates; RKP chains are at most 6.
- **`userAuthType`.** Must be exactly biometric (no password bit). The app sets `AUTH_BIOMETRIC_STRONG` only.
- **Attestation challenge.** SHA-256 of the nonce (UTF-8), because of KeyMint's 128-byte cap.
- **Challenge reuse.** `/challenge` returns the outstanding challenge while 20 s or more of its 60 s remain, so a third party who knows the serial can void it at most once it is 40 s old. A new one is minted only when none is outstanding, or it expired or was spent. Single use still holds. The per-IP cap is 120 per 5 minutes (shared site NAT).
- **Rate limit.** Biometric sign-in failures are audited under move-login's id with method `biometric`, share its per-IP cap, and return 429 `biometric_rate_limited`.
- **Shared stations.** A device with a station key or any station type (label, RFID, time clock) is never personal, on any layer: enroll returns `not_personal_device`, the challenge returns 404 `no_biometric`, and the picker and PUT refuse assigning one.
- **Regular setup.** A plain Kiosk Setup clears any station type, not only the time clock.
- **Enroll nonce errors.** Expired, spent or mismatched nonces return 422 `bad_enroll_nonce`; sign-in keeps 401 `bad_challenge`. On an authenticated route 401 means "session dead" to every client.
- **Prompt order.** The phone prompts first, then fetches the challenge and signs (auth-per-use allows the update after auth). A single-flight lock lives in `BiometricSignIn`.
- **Session binding.** Sign-in binds the new session to the key's device serial.
- **No email until validated.** No email is shown until the device card is validated; there is no fallback to a stale local record, and "Checking…" shows no email.
- **Personal candidates.** The picker uses a dedicated endpoint, `GET /devices/{id}/personal-candidates?q=`, with the same gate as PUT, returning only eligible people.
- **Revocation.** The `apply_password` choke point revokes keys on every password-setting path. A global revoke-all also revokes the caller's own keys. Changing or clearing a device's personal person revokes its live keys. An admin's forget refuses their own keys (`cannot_target_self`), so they use /me.
- **Account disabled.** Android drops its local record on `account_disabled` too.
- **Operations.** A CLI `serversherpa refresh-attestation-status` seeds the cached status list; enroll is refused with `attestation_status_unavailable` until a list exists. Malformed `SS_KIOSK_SIGNING_DIGESTS` fails settings validation; unset or empty is valid.
- **End all sessions.** The portal confirm reads: "Sign everyone out on every device? Fingerprint sign-in on their phones turns off until their next password sign-in. You will stay signed in here."

**Device pass:** Jimmy, 2026-10-24, Pixel 10 Pro XL (Kiosk F4E1) against the dev stack: "bio works".
- The dev database is migrated to 0107, the attestation status list was seeded with 1,765 entries, and the debug signing digest was added to `SS_KIOSK_SIGNING_DIGESTS`.

**Still owed**
- A real-device attestation chain fixture.
- An MC2200 check: whether its chain reaches a Google root.
- The iOS Face ID follow-up.
- The release and Play signing digests must be added to `SS_KIOSK_SIGNING_DIGESTS` before production.
