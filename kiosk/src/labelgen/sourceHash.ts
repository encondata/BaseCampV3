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
export const SOURCE_HASH = 'f87ca2ec71a3b32e4d0377af8790a4f94ad30a00b16a0d3e3b840143ebcd27a6';
