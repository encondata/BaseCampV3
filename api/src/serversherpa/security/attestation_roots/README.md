# Pinned Google hardware attestation roots

`security/key_attestation.py` trusts an Android key attestation chain only
when its last certificate carries the public key of one of these roots.

**Source:** Google's Android key attestation documentation, section "Root
certificates" (current roots, the root that signs from February 1, 2026, and
"Previously Issued Root Certificates"):
https://developer.android.com/privacy-and-security/security-key-attestation#root_certificate

The two current roots also match Google's JSON list,
https://android.googleapis.com/attestation/root. Fetched 2026-10-23.

| File | Subject | Key | Valid | SHA-256 of the DER certificate |
|---|---|---|---|---|
| `google_rsa_root_2022.pem` | SERIALNUMBER=f92009e853b6b045 | RSA 4096 | 2022-03-20 to 2042-03-15 | `cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc` |
| `google_ec_key_attestation_ca1_2025.pem` | CN=Key Attestation CA1, OU=Android, O=Google LLC, C=US | EC P-384 | 2025-07-17 to 2035-07-15 | `6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0` |
| `google_rsa_root_2016.pem` | SERIALNUMBER=f92009e853b6b045 | RSA 4096 | 2016-05-26 to 2026-05-24 | `c1984a3ef45c1e2a918551de10603c86f7051b2249c4891cae3230eabd0c97d5` |
| `google_rsa_root_2019.pem` | SERIALNUMBER=f92009e853b6b045 | RSA 4096 | 2019-11-22 to 2034-11-18 | `1ef1a04b8ba58ab94589ac498c8982a783f24ea7307e0159a0c3a73b377d87cc` |
| `google_rsa_root_2021.pem` | SERIALNUMBER=f92009e853b6b045 | RSA 4096 | 2021-11-17 to 2036-11-13 | `ab6641178a36e179aa0c1cdddf9a16eb45fa20943e2b8cd7c7c05c26cf8b487a` |

The four RSA certificates are reissues of one RSA key. The EC root ("Key
Attestation CA1") is the newer ECDSA root that Google said would begin
signing attestation chains on February 1, 2026.

## Rules that depend on these files

- A root is matched by its public key, as Google's documentation says to do
  ("If the root certificate in the attestation chain you receive contains
  this public key"). The chain's root must also verify its own signature.
- The root is the trust anchor, so its own validity dates are not checked.
  That keeps the 2016 certificate (expired 2026-05-24) usable for devices
  whose chains still embed it.
- The RSA key (subject SERIALNUMBER=f92009e853b6b045) is also the factory
  root: a chain of exactly four certificates under it, whose intermediate has
  a SERIALNUMBER subject, keeps working after its certificates expire
  (Google: "Expired factory keys: Still trustworthy"). Chains under the EC
  root, and remote-provisioned chains under the RSA root, keep their dates
  checked. A root certificate anywhere but the end of a chain is refused.
- `api/tests/test_key_attestation.py::test_pinned_google_roots` checks these
  five fingerprints, so a changed or added file fails the suite until this
  table and the test agree.

To update: download the documentation page above, compare its PEM blocks
with these files, add any new root as its own `.pem`, and update this table
and the test together.
