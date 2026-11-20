# Apple WWDR intermediates

`signing/profile.py` signs the add-device profile (`/enroll/<token>.mobileconfig`)
with the team's Apple Distribution certificate. iOS shows a signed profile as
**Verified** only when it can build the path from that certificate to an Apple
root it trusts, and a `.p12` exported from Keychain Access usually holds only
the certificate and its key. So the signed profile also carries the
"Apple Worldwide Developer Relations Certification Authority" intermediate
that issued the certificate: the one here whose subject is the certificate's
issuer (and whose key signed it), unless the `.p12` already has it.

These are public certificates (no secrets). Exported 2026-11-20 from a Mac's
keychain with
`security find-certificate -a -c "Apple Worldwide Developer Relations Certification Authority" -p`,
keeping only the unexpired ones (the original 2013 WWDR intermediate expired
on 2023-02-07). Each file is named by its generation (the subject's OU).

| File | Subject | Issuer | Key | Valid | SHA-256 of the DER certificate |
|---|---|---|---|---|---|
| `apple_wwdr_g3.pem` | CN=Apple Worldwide Developer Relations Certification Authority, OU=G3, O=Apple Inc., C=US | CN=Apple Root CA | RSA 2048 | 2020-02-19 to 2030-02-20 | `dcf21878c77f4198e4b4614f03d696d89c66c66008d4244e1b99161aac91601f` |
| `apple_wwdr_g6.pem` | CN=Apple Worldwide Developer Relations Certification Authority, OU=G6, O=Apple Inc., C=US | CN=Apple Root CA - G3 | EC P-384 | 2021-03-17 to 2036-03-19 | `bdd4ed6e74691f0c2bfd01be0296197af1379e0418e2d300efa9c3bef642ca30` |

Apple Distribution certificates are issued by G3 today. Apple also publishes
other generations (G4, G5) at https://www.apple.com/certificateauthority/;
they weren't in the keychain this was exported from. If Apple starts issuing
from one of them, add its `.pem` here (named by its OU) and a row above.

`tests/test_profile_signing.py::test_bundled_wwdr_intermediates` checks these
fingerprints against the files, so a changed or added file fails the suite
until this table and the test agree.

Before 2030-02-20, check which intermediate Apple issues distribution
certificates from and refresh this folder.
