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
export const SOURCE_HASH = '5db4098c487b0f9ef1c4fb0b6513698075add1cdc5d3576a6f2416226df1e4ca';
