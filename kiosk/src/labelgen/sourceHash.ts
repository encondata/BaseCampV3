/**
 * Written by fixtures/make_reference.py: do not edit by hand.
 *
 * The `source_hash` of fixtures/reference.json (sha256 over the Python
 * label code the reference labels were printed with). The web kiosk
 * keys its stored labels on it (lib/webLabels/labelBuild.ts), so a kiosk
 * deploy carrying a generator made from other Python rebuilds every
 * label. reference.test.ts holds it equal to the fixture's.
 *
 * Deliberately NOT imported by labelgen/index.ts: the Android/iOS bundle
 * stays byte-identical when only this hash moves.
 */
export const SOURCE_HASH = '3a806eea41ccc3eb2748b22bd01a213ed8ba2e53edc081bd430df16e1191cdec';
