# Pinned Apple App Attest root

`security/app_attest.py` trusts an App Attest attestation object only when
its intermediate certificate (the second entry of `attStmt.x5c`) is signed
by this root.

**Source:** Apple's App Attest root, linked from "Validating apps that
connect to your server" (Apple Developer documentation, DeviceCheck):
https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem

Fetched 2026-11-09.

| File | Subject | Key | Valid | SHA-256 of the DER certificate |
|---|---|---|---|---|
| `apple_app_attestation_root_ca.pem` | CN=Apple App Attestation Root CA, O=Apple Inc., ST=California | EC P-384 | 2020-03-18 to 2045-03-15 | `1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932` |

## Rules that depend on this file

- It lives in its own folder, not `attestation_roots/`: `google_roots()`
  trusts every `.pem` there, and Google's roots must never vouch for an App
  Attest statement (or this root for an Android chain).
- Unlike the Google roots, this root's own validity dates are checked, along
  with the credential certificate's and the intermediate's.
- `api/tests/test_app_attest.py::test_pinned_apple_root` checks this
  fingerprint against the file and against this table, so a changed file
  fails the suite until the table and the test agree.

To update: download the URL above, compare it with this file, and update
this table and the test together.
